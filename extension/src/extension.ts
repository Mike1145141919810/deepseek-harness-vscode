import * as vscode from 'vscode';
import { GuiPanel } from './gui-panel';
import { buildHeadlessInvocation } from './headless';
import { Logger } from './logger';
import { ServerManager, discoverCommand } from './server-manager';
import { forbiddenExtraArgs, getSettings } from './settings';
import { SidebarView } from './sidebar-view';
import { DshSettings } from './types';

export interface DshExtensionApi {
  manager: ServerManager;
  getServerUrl(): string | undefined;
  getSettings(): DshSettings;
  /** Resolves once VS Code resolves the sidebar WebviewView. */
  whenSidebarResolved(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): DshExtensionApi {
  const logger = new Logger('DeepSeek Harness');
  const manager = new ServerManager({
    settings: getSettings,
    logger,
    recordDir: context.globalStorageUri.fsPath,
  });
  const gui = new GuiPanel(context, manager, logger);
  const sidebar = new SidebarView(context, manager, logger);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(robot) DSH';
  status.tooltip = 'Open DeepSeek Harness';
  status.command = 'dsh.open';
  status.show();

  manager.onStateChange((state, instance) => {
    if (state === 'ready' && instance) {
      status.text = '$(robot) DSH';
      status.tooltip = `DeepSeek Harness running at http://127.0.0.1:${instance.port}`;
    } else if (state === 'starting') {
      status.text = '$(sync~spin) DSH';
      status.tooltip = 'DeepSeek Harness starting...';
    } else {
      status.text = '$(robot) DSH';
      status.tooltip = 'Open DeepSeek Harness';
    }
  });

  const openInBrowser = async (): Promise<void> => {
    try {
      const url = await manager.ensureUrl();
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      await vscode.window.showErrorMessage(`DeepSeek Harness: ${message}`, 'Open output').then((action) => {
        if (action === 'Open output') logger.show();
      });
    }
  };

  context.subscriptions.push(
    // `dsh.open` follows the `dsh.openIn` setting; `dsh.openBrowser` always
    // targets the system default browser.
    vscode.commands.registerCommand('dsh.open', async () => {
      const openIn = getSettings().openIn;
      if (openIn === 'browser') {
        await openInBrowser();
      } else if (openIn === 'sidebar') {
        await sidebar.open();
      } else {
        await gui.open();
      }
    }),
    vscode.commands.registerCommand('dsh.openBrowser', openInBrowser),
    vscode.commands.registerCommand('dsh.restartServer', async () => {
      try {
        const url = await manager.restart();
        void vscode.window.showInformationMessage(`DeepSeek Harness restarted at ${url}`);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        await vscode.window.showErrorMessage(`DeepSeek Harness: ${message}`, 'Open output').then((action) => {
          if (action === 'Open output') logger.show();
        });
      }
    }),
    vscode.commands.registerCommand('dsh.stopServer', async () => {
      await manager.stop();
      // Fire-and-forget: awaiting an actionless notification would block the
      // command until the user dismisses it (and hang automated runs).
      void vscode.window.showInformationMessage('DeepSeek Harness stopped.');
    }),
    vscode.commands.registerCommand('dsh.showUrl', async () => {
      try {
        const url = await manager.ensureUrl();
        await vscode.window.showInformationMessage(`DSH server: ${url}`, 'Copy', 'Open in browser').then(async (action) => {
          if (action === 'Copy') await vscode.env.clipboard.writeText(url);
          if (action === 'Open in browser') await vscode.env.openExternal(vscode.Uri.parse(url));
        });
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        await vscode.window.showErrorMessage(`DeepSeek Harness: ${message}`, 'Open output').then((action) => {
          if (action === 'Open output') logger.show();
        });
      }
    }),
    vscode.commands.registerCommand('dsh.checkInstall', async () => {
      await runDiagnostics(manager, logger);
    }),
    vscode.commands.registerCommand('dsh.runTask', async () => {
      const task = await vscode.window.showInputBox({
        prompt: 'Task for the DSH headless runner',
        placeHolder: 'e.g. Summarize this repository',
        ignoreFocusOut: true,
      });
      if (task === undefined || task.trim() === '') return;
      try {
        const settings = getSettings();
        const resolved = await discoverCommand(settings);
        const invocation = buildHeadlessInvocation(resolved, settings, task.trim());
        const terminal = vscode.window.createTerminal({
          name: 'DSH Task',
          shellPath: invocation.shellPath,
          shellArgs: invocation.shellArgs,
        });
        terminal.show();
        logger.log(`headless task started: ${task.trim()}`);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        await vscode.window.showErrorMessage(`DeepSeek Harness: ${message}`, 'Open output').then((action) => {
          if (action === 'Open output') logger.show();
        });
      }
    }),
    vscode.window.registerWebviewViewProvider('dsh.sidebarView', sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    status,
  );
  logger.log('sidebar WebviewViewProvider registered for dsh.sidebarView');

  context.subscriptions.push({
    dispose() {
      manager.dispose();
      logger.dispose();
    },
  });

  if (getSettings().autoStart) {
    void manager.ensureUrl().catch((error) => {
      logger.log(`autoStart failed: ${String(error)}`);
    });
  }

  return {
    manager,
    getServerUrl: () => manager.getUrl(),
    getSettings,
    whenSidebarResolved: () => sidebar.whenResolved(),
  };
}

export function deactivate(): void {
  // The dispose callback registered in activate() handles cleanup.
}

async function runDiagnostics(manager: ServerManager, logger: Logger): Promise<void> {
  const settings = getSettings();
  const lines: string[] = ['--- DeepSeek Harness installation check ---'];
  lines.push(`binPath setting: ${settings.binPath === '' ? '(empty, auto-detect)' : settings.binPath}`);
  lines.push(`allowNpxFallback: ${settings.allowNpxFallback}`);
  lines.push(`pinnedVersion: ${settings.pinnedVersion}`);
  const problems = forbiddenExtraArgs(settings.extraArgs);
  lines.push(
    problems.length === 0
      ? `extraArgs: ok (${settings.extraArgs.length} arg(s))`
      : `extraArgs: REJECTED flag(s): ${problems.join(', ')}`,
  );
  try {
    await manager.ensureUrl();
    lines.push(`server: READY at ${manager.getUrl()}`);
  } catch (error) {
    lines.push(`server: ${String(error instanceof Error ? error.message : error)}`);
  }
  for (const line of lines) logger.log(line);
  logger.show();
}
