import * as vscode from 'vscode';
import { GuiPanel } from './gui-panel';
import { Logger } from './logger';
import { ServerManager } from './server-manager';
import { forbiddenExtraArgs, getSettings } from './settings';
import { DshSettings } from './types';

export interface DshExtensionApi {
  manager: ServerManager;
  getServerUrl(): string | undefined;
  getSettings(): DshSettings;
}

class OpenViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const item = new vscode.TreeItem('Open DeepSeek Harness', vscode.TreeItemCollapsibleState.None);
    item.command = { command: 'dsh.open', title: 'Open' };
    item.iconPath = new vscode.ThemeIcon('robot');
    return [item];
  }
}

export function activate(context: vscode.ExtensionContext): DshExtensionApi {
  const logger = new Logger('DeepSeek Harness');
  const manager = new ServerManager({ settings: getSettings, logger });
  const gui = new GuiPanel(context, manager, logger);

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

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.open', () => gui.open()),
    vscode.commands.registerCommand('dsh.openBrowser', async () => {
      try {
        const url = await manager.ensureUrl();
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        await vscode.window.showErrorMessage(`DeepSeek Harness: ${message}`, 'Open output').then((action) => {
          if (action === 'Open output') logger.show();
        });
      }
    }),
    vscode.commands.registerCommand('dsh.restartServer', async () => {
      try {
        const url = await manager.restart();
        await vscode.window.showInformationMessage(`DeepSeek Harness restarted at ${url}`);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        await vscode.window.showErrorMessage(`DeepSeek Harness: ${message}`, 'Open output').then((action) => {
          if (action === 'Open output') logger.show();
        });
      }
    }),
    vscode.commands.registerCommand('dsh.stopServer', async () => {
      await manager.stop();
      await vscode.window.showInformationMessage('DeepSeek Harness stopped.');
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
    vscode.window.registerTreeDataProvider('dsh.openView', new OpenViewProvider()),
    status,
  );

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
