import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BRIDGE_PACKAGE_NAME,
  describeBridgeInstallation,
  detectBridgeInstallation,
  hasBridgeLoaderEntry,
  resolveDshWebProfileDir,
} from '../src/bridge-installation';

describe('resolveDshWebProfileDir', () => {
  it('honors DSH_HOME and falls back to ~/.dsh', () => {
    const configured = path.resolve('configured-dsh-home');
    assert.equal(
      resolveDshWebProfileDir({ DSH_HOME: configured }, path.resolve('unused-home')),
      path.join(configured, 'profiles', 'web'),
    );
    const userHome = path.resolve('test-user-home');
    assert.equal(
      resolveDshWebProfileDir({ DSH_HOME: '  ' }, userHome),
      path.join(userHome, '.dsh', 'profiles', 'web'),
    );
  });
});

describe('hasBridgeLoaderEntry', () => {
  it('accepts block and inline loader insert forms', () => {
    assert.equal(
      hasBridgeLoaderEntry(`- insert:\n    - id: ${BRIDGE_PACKAGE_NAME}\n      name: '${BRIDGE_PACKAGE_NAME}'`),
      true,
    );
    assert.equal(
      hasBridgeLoaderEntry(`- insert: [{ id: '${BRIDGE_PACKAGE_NAME}', name: ${BRIDGE_PACKAGE_NAME} }]`),
      true,
    );
  });

  it('does not treat commented examples or unrelated rows as configured', () => {
    assert.equal(
      hasBridgeLoaderEntry(`# - insert:\n#   - id: ${BRIDGE_PACKAGE_NAME}\n#     name: ${BRIDGE_PACKAGE_NAME}`),
      false,
    );
    assert.equal(hasBridgeLoaderEntry('- insert:\n  - id: another-plugin\n    name: another-plugin'), false);
  });
});

describe('detectBridgeInstallation', () => {
  it('reports each incomplete state and a complete install', () => {
    withTempProfile((profileDir) => {
      assert.equal(detectBridgeInstallation(profileDir).state, 'profile-missing');

      writeManifest(profileDir, {});
      assert.equal(detectBridgeInstallation(profileDir).state, 'dependency-missing');

      writeManifest(profileDir, { dependencies: { [BRIDGE_PACKAGE_NAME]: 'link:C:/bridge' } });
      assert.equal(detectBridgeInstallation(profileDir).state, 'module-missing');

      const moduleDir = path.join(profileDir, 'node_modules', BRIDGE_PACKAGE_NAME);
      fs.mkdirSync(moduleDir, { recursive: true });
      fs.writeFileSync(path.join(moduleDir, 'package.json'), '{}');
      assert.equal(detectBridgeInstallation(profileDir).state, 'loader-missing');

      fs.writeFileSync(
        path.join(profileDir, 'cordis.patch.yml'),
        `- insert:\n    - id: ${BRIDGE_PACKAGE_NAME}\n      name: '${BRIDGE_PACKAGE_NAME}'\n`,
      );
      const installed = detectBridgeInstallation(profileDir);
      assert.equal(installed.state, 'installed');
      assert.equal(installed.dependencyDeclared, true);
      assert.equal(installed.modulePresent, true);
      assert.equal(installed.loaderConfigured, true);
      assert.match(describeBridgeInstallation(installed), /^READY /);
    });
  });

  it('reports an invalid profile manifest without throwing', () => {
    withTempProfile((profileDir) => {
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'package.json'), '{broken');
      const status = detectBridgeInstallation(profileDir);
      assert.equal(status.state, 'profile-invalid');
      assert.ok(status.problem);
    });
  });
});

function writeManifest(profileDir: string, manifest: unknown): void {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest));
}

function withTempProfile(run: (profileDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-status-'));
  try {
    run(path.join(root, 'profiles', 'web'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
