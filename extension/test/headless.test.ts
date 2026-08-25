import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildHeadlessInvocation } from '../src/headless';
import { ResolvedCommand } from '../src/server-manager';
import { DshSettings } from '../src/types';

const settings: DshSettings = {
  binPath: '',
  openIn: 'panel',
  allowNpxFallback: false,
  autoStart: false,
  autoWorkspace: true,
  extraArgs: [],
  pinnedVersion: '0.1.1-rc.2',
};

const nodeBin: ResolvedCommand = {
  kind: 'node-bin',
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['C:\\dsh\\lib\\bin.js'],
  shell: false,
};

const pathCmd: ResolvedCommand = {
  kind: 'path',
  command: 'C:\\Users\\Mike Lee\\dsh.cmd',
  args: [],
  shell: true,
};

const npxCmd: ResolvedCommand = {
  kind: 'npx',
  command: 'npx.cmd',
  args: ['--yes', '@deepseek-ai/dsh@0.1.1-rc.2'],
  shell: true,
};

describe('buildHeadlessInvocation', () => {
  it('node-bin passes argv directly (no shell quoting)', () => {
    const invocation = buildHeadlessInvocation(nodeBin, settings, 'hello world', 'win32', 'cmd.exe');
    assert.equal(invocation.shellPath, nodeBin.command);
    assert.deepEqual(invocation.shellArgs, [
      'C:\\dsh\\lib\\bin.js',
      '--profile',
      'headless',
      'hello world',
    ]);
  });

  it('path on win32 runs through cmd.exe with a quoted command line', () => {
    const invocation = buildHeadlessInvocation(pathCmd, settings, 'hello world', 'win32', 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(invocation.shellPath, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(invocation.shellArgs, [
      '/d',
      '/s',
      '/c',
      '"C:\\Users\\Mike Lee\\dsh.cmd" --profile headless "hello world"',
    ]);
  });

  it('path on posix runs through /bin/sh -c with a JSON-encoded task', () => {
    const invocation = buildHeadlessInvocation(
      { ...pathCmd, command: '/usr/local/bin/dsh' },
      settings,
      'hello',
      'linux',
    );
    assert.equal(invocation.shellPath, '/bin/sh');
    assert.deepEqual(invocation.shellArgs, ['-c', "'/usr/local/bin/dsh' --profile headless \"hello\""]);
  });

  it('npx on win32 runs through cmd.exe', () => {
    const invocation = buildHeadlessInvocation(npxCmd, settings, 'task', 'win32', 'cmd.exe');
    assert.equal(invocation.shellPath, 'cmd.exe');
    assert.equal(invocation.shellArgs[0], '/d');
    assert.ok(invocation.shellArgs[3].startsWith('npx.cmd'));
  });
});
