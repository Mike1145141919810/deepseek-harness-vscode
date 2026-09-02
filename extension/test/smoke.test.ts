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
import { ApplyEditController } from '../src/apply-edit-vscode';
import {
  APPLY_EDIT_PROTOCOL_VERSION,
  APPLY_EDIT_REQUEST_MESSAGE_TYPE,
  sha256ApplyEditText,
} from '../src/apply-edit';
import { DiffPreviewProvider } from '../src/diff-preview-vscode';
import { handleDshWebviewMessage } from '../src/webview-bridge-vscode';

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

function applyRequest(
  requestId: string,
  file: string,
  beforeText: string,
  afterText: string,
) {
  return {
    type: APPLY_EDIT_REQUEST_MESSAGE_TYPE,
    version: APPLY_EDIT_PROTOCOL_VERSION,
    requestId,
    sessionId: 'smoke-session',
    file,
    beforeSha256: sha256ApplyEditText(beforeText),
    beforeText,
    afterText,
  } as const;
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

  test('confirmed apply stays unsaved and one Undo restores the exact preimage', async function () {
    this.timeout(60000);

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'the smoke runner should open its temporary workspace');
    assert.equal(vscode.workspace.isTrusted, true, 'the smoke workspace should be trusted');

    const file = path.join(workspaceFolder!.uri.fsPath, 'apply-edit.txt');
    const before = 'before\n';
    const after = 'after\nwith another line\n';
    fs.writeFileSync(file, before);

    const scheme = 'dsh-apply-edit-smoke';
    const preview = new DiffPreviewProvider(scheme);
    const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, preview);
    let confirmationCount = 0;
    const controller = new ApplyEditController(preview, {
      confirm: async (confirmation) => {
        confirmationCount += 1;
        assert.equal(confirmation.relativePath, 'apply-edit.txt');
        assert.equal(confirmation.sessionId, 'smoke-session');
        assert.equal(confirmation.beforeChars, before.length);
        assert.equal(confirmation.afterChars, after.length);
        return true;
      },
    });

    try {
      const result = await controller.apply(
        applyRequest('smoke-apply-request', file, before, after),
      );

      assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
      assert.equal(confirmationCount, 1, 'the request should require exactly one confirmation');
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, 'the applied target should become the active editor');
      assert.equal(editor!.document.uri.fsPath.toLowerCase(), file.toLowerCase());
      assert.equal(editor!.document.getText(), after);
      assert.equal(editor!.document.isDirty, true, 'the extension must not auto-save');
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'disk bytes must remain unchanged');

      await vscode.commands.executeCommand('undo');
      assert.equal(editor!.document.getText(), before, 'one Undo should restore the complete preimage');
      assert.equal(editor!.document.isDirty, false, 'undoing to the saved preimage should clear dirty');
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'Undo must not require a disk write');
    } finally {
      registration.dispose();
      preview.dispose();
      if (vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase() === file.toLowerCase()) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    }
  });

  test('cancelled apply previews but leaves the document and disk untouched', async function () {
    this.timeout(60000);

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'the smoke runner should open its temporary workspace');
    const file = path.join(workspaceFolder!.uri.fsPath, 'cancelled-edit.txt');
    const before = 'keep this\n';
    fs.writeFileSync(file, before);

    const scheme = 'dsh-apply-cancel-smoke';
    const preview = new DiffPreviewProvider(scheme);
    const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, preview);
    const controller = new ApplyEditController(preview, { confirm: async () => false });
    try {
      const result = await controller.apply(
        applyRequest('smoke-cancel-request', file, before, 'do not apply\n'),
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'USER_CANCELLED');
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath.toLowerCase() === file.toLowerCase(),
      );
      assert.equal(document?.getText(), before);
      assert.equal(document?.isDirty, false);
    } finally {
      registration.dispose();
      preview.dispose();
      if (vscode.window.activeTextEditor?.document.uri.scheme === scheme) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    }
  });

  test('apply safety gates reject trust, path, dirty, missing, and version-race failures', async function () {
    this.timeout(60000);

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'the smoke runner should open its temporary workspace');
    const workspacePath = workspaceFolder!.uri.fsPath;
    const before = 'protected\n';
    const after = 'replacement\n';
    const target = path.join(workspacePath, 'safety-gates.txt');
    fs.writeFileSync(target, before);

    let previewCount = 0;
    let confirmCount = 0;
    const preview = {
      openDocuments: async () => {
        previewCount += 1;
      },
    };
    const rejectUnexpectedConfirmation = async () => {
      confirmCount += 1;
      return false;
    };

    const untrusted = new ApplyEditController(preview, {
      confirm: rejectUnexpectedConfirmation,
      isWorkspaceTrusted: () => false,
    });
    const untrustedResult = await untrusted.apply(
      applyRequest('smoke-untrusted', target, before, after),
    );
    assert.equal(untrustedResult.ok, false);
    if (!untrustedResult.ok) assert.equal(untrustedResult.error.code, 'WORKSPACE_UNTRUSTED');

    const controller = new ApplyEditController(preview, {
      confirm: rejectUnexpectedConfirmation,
    });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-apply-outside-'));
    const outsideFile = path.join(outsideDir, 'outside.txt');
    fs.writeFileSync(outsideFile, before);
    const outsideResult = await controller.apply(
      applyRequest('smoke-outside', outsideFile, before, after),
    );
    assert.equal(outsideResult.ok, false);
    if (!outsideResult.ok) assert.equal(outsideResult.error.code, 'OUTSIDE_WORKSPACE');

    const missingResult = await controller.apply(
      applyRequest('smoke-missing', path.join(workspacePath, 'missing.txt'), before, after),
    );
    assert.equal(missingResult.ok, false);
    if (!missingResult.ok) assert.equal(missingResult.error.code, 'FILE_NOT_FOUND');

    const linkName = `outside-link-${Date.now()}`;
    const linkPath = path.join(workspacePath, linkName);
    fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    const escapedResult = await controller.apply(
      applyRequest('smoke-symlink-escape', path.join(linkPath, 'outside.txt'), before, after),
    );
    assert.equal(escapedResult.ok, false);
    if (!escapedResult.ok) assert.equal(escapedResult.error.code, 'SYMLINK_ESCAPE');

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    await editor.edit((edit) => edit.insert(document.positionAt(document.getText().length), 'dirty'));
    const dirtyResult = await controller.apply(
      applyRequest('smoke-dirty', target, before, after),
    );
    assert.equal(dirtyResult.ok, false);
    if (!dirtyResult.ok) assert.equal(dirtyResult.error.code, 'DIRTY_DOCUMENT');
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), before);
    assert.equal(document.isDirty, false);

    const versionBeforeRace = document.version;
    const raceController = new ApplyEditController(preview, {
      confirm: async () => {
        confirmCount += 1;
        const raceEditor = await vscode.window.showTextDocument(document, { preview: false });
        await raceEditor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'temporary'));
        await vscode.commands.executeCommand('undo');
        assert.equal(document.getText(), before);
        assert.equal(document.isDirty, false);
        assert.notEqual(document.version, versionBeforeRace);
        return true;
      },
    });
    const raceResult = await raceController.apply(
      applyRequest('smoke-version-race', target, before, after),
    );
    assert.equal(raceResult.ok, false);
    if (!raceResult.ok) assert.equal(raceResult.error.code, 'STALE_PREIMAGE');

    assert.equal(previewCount, 1, 'only the initially valid race request should reach preview');
    assert.equal(confirmCount, 1, 'only the initially valid race request should reach confirmation');
    assert.equal(fs.readFileSync(target, 'utf8'), before, 'no rejected request may write to disk');
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), before, 'the escaped target must be untouched');

    if (vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase() === target.toLowerCase()) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });

  test('webview apply bridge returns correlated success and bounded invalid-request errors', async function () {
    this.timeout(60000);

    const responses: unknown[] = [];
    let applyCalls = 0;
    const webview = {
      async postMessage(message: unknown) {
        responses.push(message);
        return true;
      },
    };
    const controller = {
      async apply(request: ReturnType<typeof applyRequest>) {
        applyCalls += 1;
        return {
          ok: true as const,
          requestId: request.requestId,
          sessionId: request.sessionId,
          documentVersion: 12,
        };
      },
    } as unknown as ApplyEditController;
    const logger = { log: () => undefined };
    const editorContext = {} as never;
    const file = path.join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, 'bridge.txt');
    const validRequest = applyRequest('bridge-valid', file, 'before\n', 'after\n');

    assert.equal(
      handleDshWebviewMessage(validRequest, webview, editorContext, controller, logger),
      true,
    );
    assert.ok(await waitFor(() => responses.length >= 1 ? true : undefined, 5_000, 10));
    assert.deepEqual(responses[0], {
      type: 'dsh.applyEditResult',
      requestId: 'bridge-valid',
      sessionId: 'smoke-session',
      ok: true,
      documentVersion: 12,
    });

    const malformed = { ...applyRequest('bridge-invalid', file, 'before\n', 'after\n'), extra: true };
    assert.equal(
      handleDshWebviewMessage(malformed, webview, editorContext, controller, logger),
      true,
    );
    assert.ok(await waitFor(() => responses.length >= 2 ? true : undefined, 5_000, 10));
    assert.deepEqual(responses[1], {
      type: 'dsh.applyEditResult',
      requestId: 'bridge-invalid',
      sessionId: 'smoke-session',
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'The DSH edit proposal is malformed or exceeds the safety limits.',
      },
    });

    const oversized = {
      ...applyRequest('bridge-oversized', file, 'before\n', 'after\n'),
      afterText: 'x'.repeat(1_048_577),
    };
    assert.equal(
      handleDshWebviewMessage(oversized, webview, editorContext, controller, logger),
      true,
    );
    assert.ok(await waitFor(() => responses.length >= 3 ? true : undefined, 5_000, 10));
    assert.equal((responses[2] as { ok?: boolean }).ok, false);
    assert.equal(applyCalls, 1, 'invalid proposals must never reach the native controller');
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
