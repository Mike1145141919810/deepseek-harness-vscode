/**
 * Smoke test executed INSIDE a real VS Code instance (Extension Development
 * Host) by @vscode/test-electron. Asserts the Phase 0.5 protocol chain:
 * activation -> dsh.open -> server URL -> HTTP 200 — and that the sidebar
 * view resolves its WebviewViewProvider (the machine-checkable part of the
 * sidebar form; visual content stays on the manual checklist).
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'michael-lee.dsh-vscode';

interface Api {
  getServerUrl(): string | undefined;
  /** Resolves once VS Code hands the sidebar provider a live webview view. */
  whenSidebarResolved(): Promise<void>;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, intervalMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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

suite('DSH extension smoke', () => {
  test('activates, opens the panel, and serves a healthy dsh web server', async function () {
    this.timeout(120000);

    // Test profile: force the panel surface for this test (user settings may
    // prefer the sidebar), clear a stale binPath from previous runs, and
    // point discovery at a known dsh when the runner provided one.
    const cfg = vscode.workspace.getConfiguration('dsh');
    await cfg.update('openIn', 'panel', vscode.ConfigurationTarget.Global);
    await cfg.update('binPath', process.env.DSH_BIN_PATH ?? '', vscode.ConfigurationTarget.Global);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be installed in the dev host');
    const api = (await extension!.activate()) as Api;

    await vscode.commands.executeCommand('dsh.open');
    const url = await waitFor(() => api.getServerUrl(), 60000, 500);
    assert.ok(url, 'server URL should be set after dsh.open');
    assert.match(url!, /^http:\/\/127\.0\.0\.1:\d+$/);

    const status = await httpStatus(url!);
    assert.strictEqual(status, 200, 'dsh web should answer HTTP 200 on the loopback port');

    await vscode.commands.executeCommand('dsh.stopServer');
  });

  test('dsh.openInEditor opens a file at the requested line', async function () {
    this.timeout(60000);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be installed in the dev host');
    await extension!.activate();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'));
    const file = path.join(dir, 'sample.txt');
    fs.writeFileSync(file, 'line one\nline two\nline three\n');
    try {
      await vscode.commands.executeCommand('dsh.openInEditor', {
        type: 'dsh.openInEditor',
        file,
        line: 2,
        character: 5,
      });
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, 'active editor should be set after dsh.openInEditor');
      // VS Code may normalize the Windows drive letter to lowercase; compare
      // case-insensitively.
      assert.equal(editor!.document.uri.fsPath.toLowerCase(), file.toLowerCase());
      assert.equal(editor!.selection.active.line, 1);
      assert.equal(editor!.selection.active.character, 4);
    } finally {
      // Best effort: close the editor. The temp directory is left for the OS
      // to reap — Windows can hold the file handle briefly after close, and a
      // failing rmSync would mask the actual openInEditor assertions.
      if (vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase() === file.toLowerCase()) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    }
  });

  test('sidebar view resolves its WebviewViewProvider when focused', async function () {
    this.timeout(60000);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be installed in the dev host');
    const api = (await extension!.activate()) as Api;

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('dsh.sidebarView.focus'), 'dsh.sidebarView.focus command should exist');
    assert.ok(commands.includes('workbench.view.extension.dsh'), 'dsh container focus command should exist');

    await vscode.commands.executeCommand('workbench.view.extension.dsh');
    await vscode.commands.executeCommand('dsh.sidebarView.focus');
    const resolved = await Promise.race([
      api.whenSidebarResolved().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20000)),
    ]);
    assert.ok(resolved, 'sidebar WebviewView should be resolved after focusing dsh.sidebarView');
  });
});
