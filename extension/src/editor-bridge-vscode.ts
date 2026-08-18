/**
 * VS Code half of the Phase 2A "Open in VS Code" bridge.
 *
 * Consumes a webview `dsh.openInEditor` message, validates it with
 * editor-bridge.ts, opens the file, and optionally moves the cursor to the
 * requested line/column.
 */
import * as vscode from 'vscode';
import { parseOpenInEditorMessage } from './editor-bridge';

/**
 * Open the file referenced by a webview message. Throws with a user-actionable
 * message when the payload is invalid or the file cannot be opened.
 */
export async function openInEditorFromMessage(message: unknown): Promise<void> {
  const parsed = parseOpenInEditorMessage(message);
  if (!parsed.ok) throw new Error(parsed.reason);
  const { file, line, character } = parsed.value;

  const uri = vscode.Uri.file(file);
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type !== vscode.FileType.File) {
    throw new Error(`Not a file: ${file}`);
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.One,
  });

  if (line !== undefined) {
    const position = new vscode.Position(
      Math.max(0, line - 1),
      Math.max(0, (character ?? 1) - 1),
    );
    const range = new vscode.Range(position, position);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}
