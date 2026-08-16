/**
 * Shared vscode-layer helpers for the two GUI surfaces (panel + sidebar):
 * webview template loading and workspace-folder seeding.
 */
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { getSettings } from './settings';
import { LoggerLike } from './types';
import { seedWorkspaces } from './workspace-seed';

/** Read a media/ template; failures only log and return undefined. */
export function readWebviewTemplate(
  context: vscode.ExtensionContext,
  name: string,
  logger: LoggerLike,
): string | undefined {
  const templatePath = vscode.Uri.joinPath(context.extensionUri, 'media', name);
  try {
    return fs.readFileSync(templatePath.fsPath, 'utf8');
  } catch {
    logger.log(`could not read webview template at ${templatePath.fsPath}`);
    return undefined;
  }
}

/**
 * Register the VS Code workspace folders with DSH before the GUI loads, so
 * they show up (and the newest one auto-connects) instead of the directory
 * picker. Best-effort: failures only log, never block the GUI surface.
 */
export async function seedWorkspaceFolders(url: string, logger: LoggerLike): Promise<void> {
  if (!getSettings().autoWorkspace) return;
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) return;
  const outcomes = await seedWorkspaces(url, folders.map((folder) => folder.uri.fsPath));
  for (const outcome of outcomes) {
    logger.log(
      outcome.ok
        ? `workspace seeded: ${outcome.path}`
        : `workspace seed failed for ${outcome.path}: ${outcome.detail}`,
    );
  }
}
