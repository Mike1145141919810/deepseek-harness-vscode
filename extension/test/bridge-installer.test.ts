import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BRIDGE_PACKAGE_NAME, hasBridgeLoaderEntry } from '../src/bridge-installation';
import {
  addBridgeLoaderEntry,
  buildProcessInvocation,
  installBundledBridge,
  toDshPluginPathArgument,
} from '../src/bridge-installer';
import type { ResolvedCommand } from '../src/server-manager';

const nodeCommand: ResolvedCommand = {
  kind: 'node-bin',
  command: process.execPath,
  args: ['C:/dsh/lib/bin.js'],
  shell: false,
};

describe('buildProcessInvocation', () => {
  it('passes node-bin arguments directly and preserves Electron-as-Node', () => {
    const invocation = buildProcessInvocation(
      { ...nodeCommand, electronAsNode: true },
      ['plugin', '--profile', 'web'],
      'win32',
    );
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, ['C:/dsh/lib/bin.js', 'plugin', '--profile', 'web']);
    assert.equal(invocation.env?.ELECTRON_RUN_AS_NODE, '1');
  });

  it('uses cmd.exe explicitly for Windows shims and quotes paths with spaces', () => {
    const invocation = buildProcessInvocation(
      { kind: 'path', command: '"C:/Program Files/dsh.cmd"', args: [], shell: true },
      ['plugin', '--profile', 'web', 'add', '-w', 'C:/Users/Test User/bridge'],
      'win32',
      'C:/Windows/System32/cmd.exe',
    );
    assert.equal(invocation.command, 'C:/Windows/System32/cmd.exe');
    assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(invocation.args[3], /^"C:\/Program Files\/dsh\.cmd" /);
    assert.match(invocation.args[3], /"C:\/Users\/Test User\/bridge"$/);
  });

  it('preserves literal quotes for DSH\'s inner Windows pnpm shell', () => {
    assert.equal(
      toDshPluginPathArgument('C:\\Users\\Test User\\bridge', 'win32'),
      '"C:/Users/Test User/bridge"',
    );
    assert.equal(toDshPluginPathArgument('D:\\plugins\\bridge', 'win32'), 'D:/plugins/bridge');
    assert.equal(toDshPluginPathArgument('/home/test user/bridge', 'linux'), '/home/test user/bridge');
  });
});

describe('addBridgeLoaderEntry', () => {
  it('replaces the default empty list and is idempotent', () => {
    const initial = '# user patch\r\n[]\r\n';
    const updated = addBridgeLoaderEntry(initial);
    assert.equal(hasBridgeLoaderEntry(updated), true);
    assert.equal(updated.includes('[]'), false);
    assert.equal(updated.includes('\r\n'), true);
    assert.equal(addBridgeLoaderEntry(updated), updated);
  });

  it('appends to an existing patch list and rejects a mapping root', () => {
    const updated = addBridgeLoaderEntry('- id: existing\n  disabled: true\n');
    assert.equal(hasBridgeLoaderEntry(updated), true);
    assert.match(updated, /^- id: existing/);
    assert.throws(() => addBridgeLoaderEntry('not-a-list: true\n'), /top-level YAML patch list/);
  });
});

describe('installBundledBridge', () => {
  it('runs plugin add, backs up the loader patch, and verifies installation', async () => {
    await withTempLayout(async ({ bridgeDir, profileDir }) => {
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# DSH patch\n[]\n');
      let forwarded: string[] | undefined;

      const result = await installBundledBridge({
        bundledBridgeDir: bridgeDir,
        profileDir,
        resolvedCommand: nodeCommand,
        run: async (_resolved, args) => {
          forwarded = args;
          materializeBridge(profileDir, bridgeDir);
          return { stdout: 'installed', stderr: '' };
        },
      });

      assert.deepEqual(forwarded?.slice(0, 5), ['plugin', '--profile', 'web', 'add', '-w']);
      assert.equal(result.status.state, 'installed');
      assert.equal(result.patchChanged, true);
      assert.ok(result.patchBackupPath);
      assert.equal(fs.existsSync(result.patchBackupPath!), true);
      assert.equal(
        hasBridgeLoaderEntry(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')),
        true,
      );
    });
  });

  it('does not change the loader patch when plugin installation fails', async () => {
    await withTempLayout(async ({ bridgeDir, profileDir }) => {
      fs.mkdirSync(profileDir, { recursive: true });
      const patchPath = path.join(profileDir, 'cordis.patch.yml');
      fs.writeFileSync(patchPath, '[]\n');
      await assert.rejects(
        installBundledBridge({
          bundledBridgeDir: bridgeDir,
          profileDir,
          resolvedCommand: nodeCommand,
          run: async () => { throw new Error('pnpm failed'); },
        }),
        /pnpm failed/,
      );
      assert.equal(fs.readFileSync(patchPath, 'utf8'), '[]\n');
    });
  });
});

function materializeBridge(profileDir: string, bridgeDir: string): void {
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies: { [BRIDGE_PACKAGE_NAME]: `link:${bridgeDir}` } }),
  );
  const moduleDir = path.join(profileDir, 'node_modules', BRIDGE_PACKAGE_NAME);
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: BRIDGE_PACKAGE_NAME }));
}

async function withTempLayout(
  run: (layout: { bridgeDir: string; profileDir: string }) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-installer-'));
  const bridgeDir = path.join(root, 'extension', 'dist', BRIDGE_PACKAGE_NAME);
  const profileDir = path.join(root, '.dsh', 'profiles', 'web');
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'package.json'), JSON.stringify({ name: BRIDGE_PACKAGE_NAME }));
  try {
    await run({ bridgeDir, profileDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
