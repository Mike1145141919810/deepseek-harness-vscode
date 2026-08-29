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

interface EditorContextSnapshot {
  file: string;
  languageId: string;
  cursor: { line: number; character: number };
  selection?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    text: string;
    truncated: boolean;
  };
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

  test('dsh.getEditorContext reads the selected text after focus leaves the editor', async function () {
    this.timeout(60000);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be installed in the dev host');
    await extension!.activate();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-smoke-'));
    const file = path.join(dir, 'context.ts');
    fs.writeFileSync(file, 'const first = 1;\nconst second = 2;\n');
    const panel = vscode.window.createWebviewPanel(
      'dsh.contextSmoke',
      'DSH context smoke',
      vscode.ViewColumn.One,
      {},
    );
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      editor.selection = new vscode.Selection(1, 6, 1, 12);

      // A webview is the important boundary: Phase 2B requests originate after
      // DSH has focus, when activeTextEditor may no longer identify the source.
      panel.reveal(vscode.ViewColumn.One, false);
      const snapshot = await vscode.commands.executeCommand<EditorContextSnapshot>('dsh.getEditorContext');
      assert.ok(snapshot, 'the last local-file editor should remain available');
      assert.equal(snapshot!.file.toLowerCase(), file.toLowerCase());
      assert.equal(snapshot!.languageId, 'typescript');
      assert.deepEqual(snapshot!.cursor, { line: 2, character: 13 });
      assert.deepEqual(snapshot!.selection, {
        start: { line: 2, character: 7 },
        end: { line: 2, character: 13 },
        text: 'second',
        truncated: false,
      });
    } finally {
      panel.dispose();
      if (vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase() === file.toLowerCase()) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    }
  });

  test('dsh.previewDiff opens virtual read-only documents without creating the target file', async function () {
    this.timeout(60000);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be installed in the dev host');
    await extension!.activate();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diff-smoke-'));
    const target = path.join(dir, 'not-created.ts');
    try {
      await vscode.commands.executeCommand('dsh.previewDiff', {
        type: 'dsh.previewDiff',
        file: target,
        diffs: [{ oldText: 'const value = 1;\n', newText: 'const value = 2;\n' }],
      });

      const previews = vscode.window.visibleTextEditors.filter(
        (editor) => editor.document.uri.scheme === 'dsh-diff-preview',
      );
      assert.equal(previews.length, 2, 'the diff editor should display two virtual documents');
      assert.ok(
        previews.some((editor) => editor.document.getText() === 'const value = 1;\n'),
        'the original virtual document should contain the before text',
      );
      assert.ok(
        previews.some((editor) => editor.document.getText() === 'const value = 2;\n'),
        'the modified virtual document should contain the after text',
      );
      assert.equal(fs.existsSync(target), false, 'previewing must not create the named file');
    } finally {
      if (vscode.window.activeTextEditor?.document.uri.scheme === 'dsh-diff-preview') {
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
