/** VS Code adapter for the pure Phase 2B editor-context DTO. */
import * as vscode from 'vscode';
import {
  buildEditorContextSnapshot,
  EditorContextSnapshot,
  MAX_EDITOR_SELECTION_CHARS,
} from './editor-context';

function isLocalFileEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
  return editor !== undefined && !editor.document.isClosed && editor.document.uri.scheme === 'file';
}

/** Convert one live VS Code editor into the bounded serializable DTO. */
export function captureEditorContext(editor: vscode.TextEditor): EditorContextSnapshot {
  if (!isLocalFileEditor(editor)) {
    throw new TypeError('editor must contain an open local file');
  }
  const { document, selection } = editor;
  const selectionStartOffset = document.offsetAt(selection.start);
  const selectionEndOffset = document.offsetAt(selection.end);
  const boundedEndOffset = Math.min(
    selectionEndOffset,
    selectionStartOffset + MAX_EDITOR_SELECTION_CHARS,
  );
  return buildEditorContextSnapshot({
    file: document.uri.fsPath,
    uri: document.uri.toString(),
    languageId: document.languageId,
    documentVersion: document.version,
    isDirty: document.isDirty,
    cursor: selection.active,
    ...(selection.isEmpty
      ? {}
      : {
          selection: {
            start: selection.start,
            end: selection.end,
            text: document.getText(
              new vscode.Range(selection.start, document.positionAt(boundedEndOffset)),
            ),
            truncated: boundedEndOffset < selectionEndOffset,
          },
        }),
  });
}

/**
 * Retains the last open local-file editor while focus moves into a webview.
 * Reading `window.activeTextEditor` only at request time is insufficient: it
 * can be undefined after the user clicks the embedded DSH interface.
 */
export class EditorContextTracker implements vscode.Disposable {
  private lastEditor: vscode.TextEditor | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.remember(vscode.window.activeTextEditor);
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor((editor) => this.remember(editor)),
      vscode.window.onDidChangeTextEditorSelection((event) => this.remember(event.textEditor)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.lastEditor?.document === document) this.lastEditor = undefined;
      }),
    ];
  }

  /** Current file editor, or the last one retained while a non-editor surface has focus. */
  getSnapshot(): EditorContextSnapshot | undefined {
    const active = vscode.window.activeTextEditor;
    const editor = isLocalFileEditor(active)
      ? active
      : isLocalFileEditor(this.lastEditor)
        ? this.lastEditor
        : undefined;
    if (editor === undefined) return undefined;
    this.lastEditor = editor;
    return captureEditorContext(editor);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.lastEditor = undefined;
  }

  private remember(editor: vscode.TextEditor | undefined): void {
    if (isLocalFileEditor(editor)) this.lastEditor = editor;
  }
}
