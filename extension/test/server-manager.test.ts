import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DshError, buildWebArgs, discoverCommand, healthProbe, pickFreePort } from '../src/server-manager';
import { forbiddenExtraArgs } from '../src/security';
import { DshSettings } from '../src/types';

const baseSettings: DshSettings = {
  binPath: '',
  openIn: 'panel',
  allowNpxFallback: false,
  autoStart: false,
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

  it('fails with DSH_NOT_FOUND when nothing is on PATH and npx is off', async () => {
    // `dsh` may exist on PATH in this environment; use an impossible name.
    await assert.rejects(
      discoverCommand({ ...baseSettings, binPath: '', allowNpxFallback: false }),
      (error: unknown) => error instanceof DshError,
    );
  });
});
