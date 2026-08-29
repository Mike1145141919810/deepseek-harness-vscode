/**
 * The WebviewPanel that hosts the DSH GUI in an iframe.
 *
 * Parent document: a single nonce-gated script bridges Open in Editor,
 * Phase 2B editor-context request/response, and Phase 2C diff-preview
 * messages, plus a CSP that only permits loopback frames. When the server
 * dies, the panel switches to a reconnect page; when the server comes back
 * the iframe is re-rendered.
 */
import * as vscode from 'vscode';
import { EditorContextTracker } from './editor-context-vscode';
import { readWebviewTemplate, seedWorkspaceFolders } from './gui-common';
import { ServerManager } from './server-manager';
import { LoggerLike } from './types';
import { handleDshWebviewMessage } from './webview-bridge-vscode';
import { newNonce, renderIframeHtml, renderReconnectHtml } from './webview-html';

const VIEW_TYPE = 'dsh.gui';
const TITLE = 'DeepSeek Harness';

export class GuiPanel {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ServerManager,
    private readonly editorContext: EditorContextTracker,
    private readonly logger: LoggerLike,
  ) {
    // If the server restarts (new port) while the panel is open, reload the
    // iframe against the new URL. Never opens the panel by itself.
    this.manager.onReady((url) => {
      if (this.panel) this.render(url);
    });
    // A crash (or a failed auto-restart) flips an open panel to the reconnect
    // page; `dsh.stopServer` never triggers this — only `failed` does.
    this.manager.onStateChange((state) => {
      if (state === 'failed' && this.panel) this.renderReconnect();
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
      if (this.panel) this.renderReconnect();
      return;
    }

    await seedWorkspaceFolders(url, this.logger);

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
    panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === 'dsh.retry') void this.open();
      handleDshWebviewMessage(message, panel.webview, this.editorContext, this.logger);
    });
    this.render(url);
    this.logger.log(`panel opened at ${url}`);
  }

  private render(url: string): void {
    if (!this.panel) return;
    const template = readWebviewTemplate(this.context, 'panel.html', this.logger);
    if (template === undefined) return;
    this.panel.webview.html = renderIframeHtml(template, url, newNonce());
  }

  private renderReconnect(): void {
    if (!this.panel) return;
    const template = readWebviewTemplate(this.context, 'reconnect.html', this.logger);
    if (template === undefined) return;
    this.panel.webview.html = renderReconnectHtml(template, newNonce());
    this.logger.log('panel switched to reconnect page (server failed)');
  }
}
