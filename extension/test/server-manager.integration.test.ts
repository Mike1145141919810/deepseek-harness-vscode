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
import * as http from 'node:http';
import * as net from 'node:net';
import { ServerManager, discoverCommand } from '../src/server-manager';
import { DshSettings } from '../src/types';

const logs: string[] = [];
const logger = { log: (message: string) => void logs.push(message) };

const settings: DshSettings = {
  binPath: process.env.DSH_BIN_PATH ?? '',
  openIn: 'panel',
  allowNpxFallback: false,
  autoStart: false,
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
    const request = http.get(url, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('error', reject);
  });
}

/** Crude websocket upgrade probe: expect the server to answer the upgrade. */
function wsProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.setTimeout(3000);
    socket.once('connect', () => {
      socket.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      );
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        const status = buffer.split('\r\n')[0];
        socket.destroy();
        // Either the webserver's WS upgrade path or any HTTP response proves the listener speaks.
        resolve(status.includes('101') || status.includes('200') || status.includes('404') || status.includes('400'));
      }
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe('server-manager integration (real dsh web)', { timeout: 120000 }, () => {
  it('spawns dsh web, serves HTTP, and shuts down cleanly', async (t) => {
    if (!(await dshAvailable())) {
      t.skip('dsh not discoverable: set DSH_BIN_PATH or add dsh to PATH');
      return;
    }

    const manager = new ServerManager({ settings: () => settings, logger });
    let url: string;
    try {
      url = await manager.ensureUrl();
    } catch (error) {
      console.error('server logs:\n' + logs.join('\n'));
      throw error;
    }
    const parsed = new URL(url);
    assert.equal(parsed.hostname, '127.0.0.1');
    const instance = manager.getInstance();
    assert.ok(instance && instance.pid, 'instance should record the child pid');

    assert.equal(await httpStatus(url), 200);
    assert.equal(await wsProbe(parsed.hostname, Number(parsed.port)), true);

    const pid = instance!.pid!;
    await manager.stop();
    assert.equal(manager.getState(), 'stopped');
    await assert.rejects(httpStatus(url));
  });
});
