// Launches the Extension Development Host with a locally installed VS Code
// and runs the smoke suite. No VS Code download is performed.
//
// DSH_BIN_PATH env: optional path to dsh's lib/bin.js; forwarded to the test.
// VSCODE_EXE env: optional path to the Code executable; defaults are probed.
const { runTests } = require('@vscode/test-electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaults = [
  process.env.VSCODE_EXE,
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  '/usr/bin/code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
].filter(Boolean);

async function main() {
  const vscodeExecutablePath = defaults.find((candidate) => fs.existsSync(candidate));
  if (!vscodeExecutablePath) {
    console.error('VS Code executable not found; set VSCODE_EXE to the Code binary.');
    process.exit(2);
  }
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'run-tests.js');
  const smokeWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vscode-smoke-workspace-'));

  const env = { ...process.env };
  if (!env.DSH_BIN_PATH && fs.existsSync(env.DSH_BIN_PATH ?? '')) {
    /* noop */
  }

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      smokeWorkspacePath,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
    env: {
      ...env,
      DSH_BIN_PATH: env.DSH_BIN_PATH || '',
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
