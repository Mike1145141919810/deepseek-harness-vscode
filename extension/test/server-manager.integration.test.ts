/**
 * Phase 0.5 integration spike (slow): drives the REAL dsh web server through
 * the ServerManager — spawn, health, HTTP 200, WebSocket upgrade check, and
 * shutdown with no process left behind.
 *
 * Requires dsh to be discoverable: set DSH_BIN_PATH to dsh's lib/bin.js, or
 * have `dsh` on PATH. Skips otherwise.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ServerManager, discoverCommand } from '../src/server-manager';
import { loadInstanceRecord, saveInstanceRecord } from '../src/instance-record';
import { DshSettings } from '../src/types';
import { seedWorkspace, deleteWorkspace } from '../src/workspace-seed';

const logs: string[] = [];
const logger = { log: (message: string) => { logs.push(message); console.log('[dsh]', message); } };

const settings: DshSettings = {
  binPath: process.env.DSH_BIN_PATH ?? '',
  openIn: 'panel',
  allowNpxFallback: false,
  autoStart: false,
  autoWorkspace: true,
  extraArgs: [],
  pinnedVersion: '0.1.0-rc.6',
};

async function dshAvailable(): Promise<boolean> {
  try {
    await discoverCommand(settings);
    return true;
  } catch {
    return false;
  }
}

function httpStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false, timeout: 5000 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('error', reject);
    request.once('timeout', () => {
      request.destroy();
      reject(new Error('httpStatus timeout'));
    });
  });
}

/**
 * Count live processes whose command line contains `marker` (the resolved
 * dsh bin.js). Returns undefined when the platform tooling is unavailable —
 * the caller then skips the process-count assertion.
 */
function countDshProcesses(marker: string): number | undefined {
  try {
    if (process.platform === 'win32') {
      // PowerShell wildcard syntax: backtick escapes wildcards, backslash is
      // literal; only single quotes need doubling inside a '-like' pattern.
      const escaped = marker.replace(/'/g, "''");
      const script = `(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*${escaped}*' }).Count`;
      const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
      });
      const count = Number(out.trim());
      return Number.isInteger(count) && count >= 0 ? count : undefined;
    }
    const out = cp.execFileSync('pgrep', ['-fc', marker], { encoding: 'utf8', timeout: 20000 });
    const count = Number(out.trim());
    return Number.isInteger(count) && count >= 0 ? count : undefined;
  } catch {
    return undefined;
  }
}

/**
 * WebSocket probe against the browser mux downlink (`/api/events.mux`).
 * Expects a `101 Switching Protocols` handshake answer. Every exit path
 * (data/error/timeout/close) settles the promise so this can never hang.
 */
/**
 * WebSocket probe against the browser mux downlink (`/api/events.mux`).
 * Expects a `101 Switching Protocols` handshake answer. Every exit path
 * (data/error/timeout/close) settles the promise so this can never hang.
 *
 * The probe retries: dsh registers its WS upgrade routes only once the
 * apiProxy service is ready, slightly AFTER the HTTP listener starts serving,
 * so a handshake fired immediately after HTTP-ready can race the registration.
 * The GUI's own WS client reconnects the same way.
 */
function wsProbeOnce(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect(port, host);
    const finish = (value: boolean, why: string) => {
      if (settled) return;
      settled = true;
      console.log(`wsProbe attempt settled: ${why} (received ${buffer.length} bytes: ${JSON.stringify(buffer.slice(0, 60))})`);
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(5000);
    socket.once('connect', () => {
      socket.write(
        [
          'GET /api/events.mux HTTP/1.1',
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'),
      );
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        const statusLine = buffer.split('\r\n')[0];
        finish(statusLine.includes('101'), `data (${statusLine})`);
      }
    });
    socket.once('error', (error) => finish(false, `error ${String(error)}`));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('close', () => finish(false, 'close'));
  });
}

async function wsProbe(host: string, port: number): Promise<boolean> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (await wsProbeOnce(host, port)) return true;
    console.log(`wsProbe: retry ${attempt + 1}/5 in 500ms (boot race)`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

describe('server-manager integration (real dsh web)', { timeout: 120000 }, () => {
  it('spawns dsh web, serves HTTP, persists the instance record, and shuts down cleanly', async (t) => {
    console.log('checking dsh availability...');
    if (!(await dshAvailable())) {
      t.skip('dsh not discoverable: set DSH_BIN_PATH or add dsh to PATH');
      return;
    }
    console.log('dsh available, starting manager...');

    const resolved = await discoverCommand(settings);
    const marker = resolved.kind === 'node-bin' ? resolved.args[0] : undefined;
    const baseline = marker !== undefined ? countDshProcesses(marker) : undefined;

    const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-record-'));
    // Pre-seed a dead record: the manager must detect and clear it on start.
    saveInstanceRecord(recordDir, {
      v: 1,
      instanceId: 'stale-instance',
      pid: 999999999,
      port: 65000,
      startedAt: new Date().toISOString(),
    });

    const manager = new ServerManager({ settings: () => settings, logger, recordDir });
    try {
      let url: string;
      try {
        url = await manager.ensureUrl();
      } catch (error) {
        console.error('server logs:\n' + logs.join('\n'));
        throw error;
      }
      const parsed = new URL(url);
      console.log('step: assert host/instance');
      assert.equal(parsed.hostname, '127.0.0.1');
      const instance = manager.getInstance();
      assert.ok(instance && instance.pid, 'instance should record the child pid');

      console.log('step: stale detection + record persistence');
      assert.ok(
        logs.some((line) => line.includes('[stale] cleared stale dsh instance record')),
        'pre-seeded stale record should be detected and cleared',
      );
      const record = loadInstanceRecord(recordDir);
      assert.equal(record?.instanceId, instance.instanceId, 'record should reflect the new instance');
      assert.equal(record?.pid, instance.pid);
      assert.equal(record?.port, Number(parsed.port));

      console.log('step: httpStatus');
      assert.equal(await httpStatus(url), 200);
      console.log('step: wsProbe');
      assert.equal(await wsProbe(parsed.hostname, Number(parsed.port)), true);

      console.log('step: workspace seeding');
      const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seed-'));
      let seededWorkspaceId: string | undefined;
      try {
        const first = await seedWorkspace(url, seedDir);
        assert.equal(first.ok, true, `seed failed: ${first.detail}`);
        assert.equal(first.created, true);
        seededWorkspaceId = first.workspaceId;
        assert.ok(seededWorkspaceId, 'create should return the workspaceId');
        // Idempotent: re-seeding the same path resolves the same workspace.
        const second = await seedWorkspace(url, seedDir);
        assert.equal(second.ok, true, `re-seed failed: ${second.detail}`);
        assert.equal(second.created, false);
        assert.equal(second.workspaceId, seededWorkspaceId);
      } finally {
        if (seededWorkspaceId !== undefined) {
          const removed = await deleteWorkspace(url, seededWorkspaceId);
          assert.equal(removed.ok, true, `workspace cleanup failed: ${removed.detail}`);
        }
        fs.rmSync(seedDir, { recursive: true, force: true });
      }

      console.log('step: stop');
      await manager.stop();
      assert.equal(manager.getState(), 'stopped');
      assert.equal(loadInstanceRecord(recordDir), undefined, 'record should be removed on clean stop');
      console.log('step: expect dead port');
      await assert.rejects(httpStatus(url));

      console.log('step: process count returns to baseline');
      if (marker !== undefined && baseline !== undefined) {
        let after = countDshProcesses(marker);
        const deadline = Date.now() + 10000;
        while (after !== baseline && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          after = countDshProcesses(marker);
        }
        assert.equal(after, baseline, `dsh process count should return to baseline ${baseline} after shutdown`);
      } else {
        console.log('process-count tooling unavailable; skipping that assertion');
      }

      console.log('step: done');
    } finally {
      // Never leave a live dsh behind, even when an assertion failed midway.
      manager.dispose();
      fs.rmSync(recordDir, { recursive: true, force: true });
    }
  });

  it('adopts a live instance from another window and detaches without killing it', async (t) => {
    console.log('checking dsh availability for adoption test...');
    if (!(await dshAvailable())) {
      t.skip('dsh not discoverable: set DSH_BIN_PATH or add dsh to PATH');
      return;
    }

    const resolved = await discoverCommand(settings);
    const marker = resolved.kind === 'node-bin' ? resolved.args[0] : undefined;
    const baseline = marker !== undefined ? countDshProcesses(marker) : undefined;

    const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shared-'));
    const managerA = new ServerManager({ settings: () => settings, logger, recordDir });
    const managerB = new ServerManager({ settings: () => settings, logger, recordDir });
    try {
      console.log('step: A starts and owns the server');
      const urlA = await managerA.ensureUrl();
      const portA = new URL(urlA).port;
      const pidA = managerA.getInstance()!.pid;
      const countAfterA = marker !== undefined ? countDshProcesses(marker) : undefined;

      console.log('step: B adopts the same instance');
      const urlB = await managerB.ensureUrl();
      assert.equal(new URL(urlB).port, portA, 'second window should reuse the same port');
      assert.equal(managerB.getInstance()?.pid, pidA, 'second window should adopt the same pid');
      assert.equal(managerB.getState(), 'ready');
      assert.ok(
        logs.some((line) => line.includes('reusing existing dsh instance')),
        'adoption should be logged',
      );
      if (marker !== undefined && countAfterA !== undefined) {
        assert.equal(
          countDshProcesses(marker),
          countAfterA,
          'second window must not add a dsh process',
        );
      }

      console.log('step: B stops -> detach only, A stays healthy, record remains');
      await managerB.stop();
      assert.equal(managerB.getState(), 'stopped');
      assert.equal(await httpStatus(urlA), 200, 'owner instance should survive B.stop');
      assert.ok(loadInstanceRecord(recordDir), 'record should remain (owned by A)');
      if (marker !== undefined && countAfterA !== undefined) {
        assert.equal(
          countDshProcesses(marker),
          countAfterA,
          'detach must not kill the owner process',
        );
      }

      console.log('step: A stops -> record cleared and port dead');
      await managerA.stop();
      assert.equal(loadInstanceRecord(recordDir), undefined, 'record should be removed by the owner');
      await assert.rejects(httpStatus(urlA));
      if (marker !== undefined && baseline !== undefined) {
        let after = countDshProcesses(marker);
        const deadline = Date.now() + 10000;
        while (after !== baseline && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          after = countDshProcesses(marker);
        }
        assert.equal(after, baseline, 'process count should return to baseline after owner stop');
      }
      console.log('step: done');
    } finally {
      managerB.dispose();
      managerA.dispose();
      fs.rmSync(recordDir, { recursive: true, force: true });
    }
  });
});
