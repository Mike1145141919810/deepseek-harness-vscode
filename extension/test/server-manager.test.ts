import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DshError, buildWebArgs, discoverCommand, healthProbe, pickFreePort, pickPathCandidate, resolveShimScript } from '../src/server-manager';
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

describe('resolveShimScript', () => {
  it('resolves the node script behind an npm cmd shim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmdshim-'));
    try {
      const shim = path.join(dir, 'node_modules', '.bin', 'dsh.cmd');
      fs.mkdirSync(path.dirname(shim), { recursive: true });
      fs.writeFileSync(
        shim,
        '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\n"%_prog%"  "%dp0%\\..\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
      );
      const expected = path.resolve(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      assert.equal(resolveShimScript(shim), path.normalize(expected));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the npm-prefix cmd shim layout (npm >= 10, no ".." segment)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-newshim-'));
    try {
      const shim = path.join(dir, 'dsh.cmd');
      fs.writeFileSync(
        shim,
        '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
      );
      const expected = path.resolve(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      assert.equal(resolveShimScript(shim), path.normalize(expected));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the node script behind an sh shim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shshim-'));
    try {
      const shim = path.join(dir, 'dsh');
      fs.writeFileSync(shim, '#!/bin/sh\nexec node  "$basedir/../@deepseek-ai/dsh/lib/bin.js" "$@"\n');
      const expected = path.resolve(dir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      assert.equal(resolveShimScript(shim), path.normalize(expected));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for a shim it does not recognize', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-othershim-'));
    try {
      const shim = path.join(dir, 'dsh.cmd');
      fs.writeFileSync(shim, '@echo off\r\necho hello\r\n');
      assert.equal(resolveShimScript(shim), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      await assert.rejects(
        discoverCommand({ ...baseSettings, binPath: '', allowNpxFallback: false }, process.platform, dir),
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
        dir,
      );
      assert.equal(command.kind, 'path');
      assert.ok(command.command.replace(/"/g, '').toLowerCase().endsWith('dsh.cmd'));
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
        dir,
      );
      assert.equal(command.kind, 'path');
      assert.ok(command.command.replace(/"/g, '').toLowerCase().endsWith('dsh.cmd'));
      assert.equal(command.shell, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the node script behind an npm cmd shim directly (win32)', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('win32-only npm cmd shim resolution');
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npmcmd-'));
    try {
      const binDir = path.join(root, 'node_modules', '.bin');
      const pkgBin = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      fs.mkdirSync(path.dirname(pkgBin), { recursive: true });
      fs.writeFileSync(pkgBin, '#!/usr/bin/env node\n');
      const shim = path.join(binDir, 'dsh.cmd');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\..\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n');
      const command = await discoverCommand(
        { ...baseSettings, binPath: '', allowNpxFallback: false },
        process.platform,
        binDir,
      );
      assert.equal(command.kind, 'node-bin');
      assert.equal(command.command, process.execPath);
      // `where` may return the long or 8.3 form of the user profile path;
      // canonicalize both sides before comparing.
      assert.equal(
        fs.realpathSync.native(command.args[0]).toLowerCase(),
        fs.realpathSync.native(pkgBin).toLowerCase(),
      );
      assert.equal(command.shell, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
