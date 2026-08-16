/**
 * Sidebar form: a WebviewView in the activity-bar container that hosts the
 * same iframe page as the panel. State transitions mirror GuiPanel:
 *   not ready -> placeholder with an Open button (no auto-start on reveal)
 *   failed   -> reconnect page (nonce-gated retry script)
 *   ready    -> iframe (re-rendered automatically on every new port)
 */
import * as vscode from 'vscode';
import { readWebviewTemplate, seedWorkspaceFolders } from './gui-common';
import { ServerManager } from './server-manager';
import { LoggerLike } from './types';
import { newNonce, renderIframeHtml, renderNonceTemplate } from './webview-html';

const VIEW_ID = 'dsh.sidebarView';

export class SidebarView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  /** URL from a start that completed before the view was first resolved. */
  private pendingUrl?: string;
  private readonly resolutionPromise: Promise<void>;
  private markResolved!: () => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ServerManager,
    private readonly logger: LoggerLike,
  ) {
    this.resolutionPromise = new Promise<void>((resolve) => {
      this.markResolved = resolve;
    });
    this.manager.onReady((url) => {
      this.pendingUrl = undefined;
      if (this.view) this.renderIframe(url);
    });
    this.manager.onStateChange((state) => {
      if (!this.view) return;
      if (state === 'failed') this.renderReconnect();
      else if (state === 'stopped') this.renderPlaceholder();
    });
  }

  /** Resolves once VS Code has handed the provider a live webview view. */
  whenResolved(): Promise<void> {
    return this.resolutionPromise;
  }

  /** Reveal the sidebar and make sure the server runs behind the iframe. */
  async open(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    try {
      const url = await this.manager.ensureUrl();
      await seedWorkspaceFolders(url, this.logger);
      if (this.view) this.renderIframe(url);
      else this.pendingUrl = url;
    } catch (error) {
      this.logger.log(`sidebar open failed: ${String(error)}`);
      const message = String(error instanceof Error ? error.message : error);
      const action = await vscode.window.showErrorMessage(`DeepSeek Harness: ${message}`, 'Run diagnostics', 'Open output');
      if (action === 'Run diagnostics') await vscode.commands.executeCommand('dsh.checkInstall');
      if (action === 'Open output') this.logger.show?.();
      if (this.view) this.renderReconnect();
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.logger.log(`sidebar view resolved (visible=${view.visible})`);
    this.markResolved();
    this.view = view;
    view.webview.options = {
      // Same reason as the panel: enableScripts governs the WHOLE webview
      // context, iframe included, and the DSH SPA is a JS-rendered app.
      enableScripts: true,
    };
    view.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === 'dsh.open' || message?.type === 'dsh.retry') void this.open();
    });

    const url = this.pendingUrl ?? this.manager.getUrl();
    if (url && this.manager.getState() === 'ready') {
      this.renderIframe(url);
    } else if (this.manager.getState() === 'failed') {
      this.renderReconnect();
    } else {
      this.renderPlaceholder();
    }
  }

  private renderIframe(url: string): void {
    if (!this.view) return;
    const template = readWebviewTemplate(this.context, 'panel.html', this.logger);
    if (template === undefined) return;
    this.view.webview.html = renderIframeHtml(template, url);
  }

  private renderReconnect(): void {
    if (!this.view) return;
    const template = readWebviewTemplate(this.context, 'reconnect.html', this.logger);
    if (template === undefined) return;
    this.view.webview.html = renderNonceTemplate(template, newNonce());
    this.logger.log('sidebar switched to reconnect page (server failed)');
  }

  private renderPlaceholder(): void {
    if (!this.view) return;
    const template = readWebviewTemplate(this.context, 'sidebar-empty.html', this.logger);
    if (template === undefined) return;
    this.view.webview.html = renderNonceTemplate(template, newNonce());
  }
}
