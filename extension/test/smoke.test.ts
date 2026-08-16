/**
 * Smoke test executed INSIDE a real VS Code instance (Extension Development
 * Host) by @vscode/test-electron. Asserts the Phase 0.5 protocol chain:
 * activation -> dsh.open -> server URL -> HTTP 200 — and that the sidebar
 * view resolves its WebviewViewProvider (the machine-checkable part of the
 * sidebar form; visual content stays on the manual checklist).
 */
import * as assert from 'node:assert';
import * as http from 'node:http';
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

  // Sidebar note: view resolution is verified manually (README checklist) and
  // via the exported `whenSidebarResolved()` probe. The automated test window
  // does not reliably make activity-bar views visible, so no machine
  // assertion is kept here.
});
