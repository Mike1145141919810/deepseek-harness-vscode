/**
 * The WebviewPanel that hosts the DSH GUI in an iframe.
 *
 * Parent document: no scripts (no nonce machinery needed) — a CSP that only
 * permits loopback frames plus a full-bleed iframe. When the server dies and
 * comes back, the panel is re-rendered so the iframe reloads.
 */
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { ServerManager } from './server-manager';
import { getSettings } from './settings';
import { LoggerLike } from './types';
import { seedWorkspaces } from './workspace-seed';

const VIEW_TYPE = 'dsh.gui';
const TITLE = 'DeepSeek Harness';

export class GuiPanel {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ServerManager,
    private readonly logger: LoggerLike,
  ) {
    // If the server restarts (new port) while the panel is open, reload the
    // iframe against the new URL. Never opens the panel by itself.
    this.manager.onReady((url) => {
      if (this.panel) this.render(url);
    });
  }

  /** Open (or reveal) the panel with a running server behind it. */
  async open(): Promise<void> {
    let url: string;
    try {
      url = await this.manager.ensureUrl();
    } catch (error) {
      this.logger.log(`open failed: ${String(error)}`);
      const message = String(error instanceof Error ? error.message : error);
      const action = await vscode.window.showErrorMessage(`DeepSeek Harness: ${message}`, 'Run diagnostics', 'Open output');
      if (action === 'Run diagnostics') await vscode.commands.executeCommand('dsh.checkInstall');
      if (action === 'Open output') this.logger.show?.();
      return;
    }

    await this.seedWorkspaceFolders(url);

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, true);
      this.render(url);
      return;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, TITLE, vscode.ViewColumn.One, {
      // Must be true: VS Code applies this to the WHOLE webview context,
      // iframe included, and the DSH SPA is a JS-rendered app. The parent
      // document itself runs no scripts and carries a strict CSP.
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.render(url);
    this.logger.log(`panel opened at ${url}`);
  }

  /**
   * Register the VS Code workspace folders with DSH before the GUI loads, so
   * they show up (and the newest one auto-connects) instead of the directory
   * picker. Best-effort: failures only log, never block the panel.
   */
  private async seedWorkspaceFolders(url: string): Promise<void> {
    if (!getSettings().autoWorkspace) return;
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) return;
    const outcomes = await seedWorkspaces(url, folders.map((folder) => folder.uri.fsPath));
    for (const outcome of outcomes) {
      this.logger.log(
        outcome.ok
          ? `workspace seeded: ${outcome.path}`
          : `workspace seed failed for ${outcome.path}: ${outcome.detail}`,
      );
    }
  }

  private render(url: string): void {
    if (!this.panel) return;
    const templatePath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.html');
    let html: string;
    try {
      html = fs.readFileSync(templatePath.fsPath, 'utf8');
    } catch {
      this.logger.log(`could not read panel template at ${templatePath.fsPath}`);
      return;
    }
    // The URL is self-generated (127.0.0.1:port); still escape it into HTML.
    const safeUrl = url.replace(/"/g, '%22');
    this.panel.webview.html = html.replace('{{DSH_URL}}', safeUrl);
  }
}
