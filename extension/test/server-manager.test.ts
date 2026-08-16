import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DshError, buildWebArgs, discoverCommand, healthProbe, pickFreePort, pickPathCandidate } from '../src/server-manager';
import { forbiddenExtraArgs } from '../src/security';
import { DshSettings } from '../src/types';

const baseSettings: DshSettings = {
  binPath: '',
  openIn: 'panel',
  allowNpxFallback: false,
  autoStart: false,
  autoWorkspace: true,
  extraArgs: [],
  pinnedVersion: '0.1.0-rc.6',
};

describe('buildWebArgs', () => {
  it('always puts the fixed host/port first, then extraArgs', () => {
    const args = buildWebArgs(43210, ['--patch', 'x.yml']);
    assert.deepEqual(args, ['web', '--host', '127.0.0.1', '--port', '43210', '--patch', 'x.yml']);
  });
});

describe('forbiddenExtraArgs', () => {
  it('rejects safety flags in both shapes', () => {
    assert.deepEqual(forbiddenExtraArgs(['--host', '0.0.0.0']), ['--host']);
    assert.deepEqual(forbiddenExtraArgs(['--port=8080']), ['--port=8080']);
    assert.deepEqual(forbiddenExtraArgs(['--trusted-host', 'lan']), ['--trusted-host']);
    assert.deepEqual(forbiddenExtraArgs(['--patch', 'x.yml']), []);
    assert.deepEqual(forbiddenExtraArgs([]), []);
  });
});

describe('pickPathCandidate', () => {
  it('prefers a runnable Windows shim over the extensionless npm shim', () => {
    assert.equal(pickPathCandidate(['C:/tmp/bin/dsh', 'C:/tmp/bin/dsh.cmd'], true), 'C:/tmp/bin/dsh.cmd');
  });

  it('prefers a native .exe on Windows', () => {
    assert.equal(pickPathCandidate(['C:/x/dsh', 'C:/x/dsh.exe', 'C:/x/dsh.cmd'], true), 'C:/x/dsh.exe');
  });

  it('falls back to the first match when no runnable extension exists', () => {
    assert.equal(pickPathCandidate(['C:/x/dsh'], true), 'C:/x/dsh');
  });

  it('uses the first match on non-Windows and handles empty lists', () => {
    assert.equal(pickPathCandidate(['/usr/bin/dsh'], false), '/usr/bin/dsh');
    assert.equal(pickPathCandidate([], false), undefined);
  });
});

describe('pickFreePort / healthProbe', () => {
  it('allocates a loopback port that is not yet serving', async () => {
    const port = await pickFreePort();
    assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);
    assert.equal(await healthProbe(port, 500), false);
  });
});

describe('discoverCommand', () => {
  it('resolves a configured bin.js', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bin-'));
    const bin = path.join(dir, 'lib', 'bin.js');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/usr/bin/env node\n');
    try {
      const command = await discoverCommand({ ...baseSettings, binPath: dir });
      assert.equal(command.kind, 'node-bin');
      assert.equal(command.command, process.execPath);
      assert.deepEqual(command.args, [bin]);
      assert.equal(command.shell, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with DSH_NOT_FOUND for a bad binPath', async () => {
    await assert.rejects(
      discoverCommand({ ...baseSettings, binPath: 'Z:/definitely/not/here' }),
      (error: unknown) => error instanceof DshError && error.code === 'DSH_NOT_FOUND',
    );
  });

  it('fails with DSH_NOT_FOUND when dsh is not on the (injected) PATH and npx is off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nopath-'));
    try {
      // Keep `where`/`which` resolvable by including the system directory.
      const systemDir = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin';
      await assert.rejects(
        discoverCommand({ ...baseSettings, binPath: '', allowNpxFallback: false }, process.platform, `${dir}${path.delimiter}${systemDir}`),
        (error: unknown) => error instanceof DshError && error.code === 'DSH_NOT_FOUND',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a dsh shim on the injected PATH (win32)', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('win32-only shim resolution');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shim-'));
    const shim = path.join(dir, 'dsh.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');
    try {
      const command = await discoverCommand(
        { ...baseSettings, binPath: '', allowNpxFallback: false },
        process.platform,
        `${dir}${path.delimiter}C:\\Windows\\System32`,
      );
      assert.equal(command.kind, 'path');
      assert.ok(command.command.toLowerCase().endsWith('dsh.cmd'));
      assert.equal(command.shell, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers dsh.cmd over the extensionless shim on the injected PATH (win32)', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('win32-only shim resolution');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shims-'));
    fs.writeFileSync(path.join(dir, 'dsh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'dsh.cmd'), '@echo off\r\n');
    try {
      const command = await discoverCommand(
        { ...baseSettings, binPath: '', allowNpxFallback: false },
        process.platform,
        `${dir}${path.delimiter}C:\\Windows\\System32`,
      );
      assert.equal(command.kind, 'path');
      assert.ok(command.command.toLowerCase().endsWith('dsh.cmd'));
      assert.equal(command.shell, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
