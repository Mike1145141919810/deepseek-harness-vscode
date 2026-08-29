/** VS Code adapter for the Phase 2C read-only contextual diff preview. */
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildDiffPreviewDocuments,
  DiffPreviewMessage,
  parseDiffPreviewMessage,
} from './diff-preview';

export const DIFF_PREVIEW_URI_SCHEME = 'dsh-diff-preview';
const MAX_RETAINED_DIFF_PREVIEWS = 20;

interface StoredPreview {
  original: vscode.Uri;
  modified: vscode.Uri;
}

/**
 * Serves bounded in-memory documents to VS Code's built-in diff editor. It
 * never opens, reads, modifies, or creates the real file named by the request.
 */
export class DiffPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly content = new Map<string, string>();
  private readonly retained: StoredPreview[] = [];
  private nextId = 1;

  provideTextDocumentContent(uri: vscode.Uri): string | undefined {
    return this.content.get(uri.toString());
  }

  /** Validate a request and open its contextual hunks in a preview diff tab. */
  async openFromMessage(value: unknown): Promise<DiffPreviewMessage> {
    const parsed = parseDiffPreviewMessage(value);
    if (!parsed.ok) throw new TypeError(`Invalid diff preview message: ${parsed.reason}`);

    const documents = buildDiffPreviewDocuments(parsed.value.diffs);
    const id = this.nextId;
    this.nextId += 1;
    const fileName = safeVirtualFileName(parsed.value.file);
    const original = vscode.Uri.from({
      scheme: DIFF_PREVIEW_URI_SCHEME,
      authority: 'preview',
      path: `/${id}/original/${fileName}`,
    });
    const modified = vscode.Uri.from({
      scheme: DIFF_PREVIEW_URI_SCHEME,
      authority: 'preview',
      path: `/${id}/modified/${fileName}`,
    });
    this.content.set(original.toString(), documents.original);
    this.content.set(modified.toString(), documents.modified);
    this.retained.push({ original, modified });
    this.trimRetainedPreviews();

    await vscode.commands.executeCommand(
      'vscode.diff',
      original,
      modified,
      `DSH Diff: ${path.basename(parsed.value.file) || 'change'}`,
      { preview: true },
    );
    return parsed.value;
  }

  dispose(): void {
    this.content.clear();
    this.retained.length = 0;
  }

  private trimRetainedPreviews(): void {
    while (this.retained.length > MAX_RETAINED_DIFF_PREVIEWS) {
      const oldest = this.retained.shift();
      if (oldest === undefined) return;
      this.content.delete(oldest.original.toString());
      this.content.delete(oldest.modified.toString());
    }
  }
}

function safeVirtualFileName(file: string): string {
  const base = path.basename(file);
  if (base === '' || base === '.' || base === path.parse(file).root) return 'change.txt';
  // URI paths treat slashes as hierarchy. basename already removes platform
  // separators; replace the remaining control delimiters defensively.
  return base.replace(/[?#]/gu, '_');
}
