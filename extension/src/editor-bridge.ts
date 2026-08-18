/**
 * Pure message parsing for the Phase 2A "Open in VS Code" bridge.
 *
 * Wire shape (iframe -> parent webview -> extension host):
 *   iframe:  { type: 'dsh:openInEditor', file, line?, character? }
 *   webview: { type: 'dsh.openInEditor', file, line?, character? }
 *
 * This module has no `vscode` import so the parser is unit-testable in a
 * plain Node process. The actual `vscode.workspace.openTextDocument` call
 * lives in editor-bridge-vscode.ts.
 */
import * as path from 'node:path';

export const OPEN_IN_EDITOR_MESSAGE_TYPE = 'dsh.openInEditor';

export interface OpenInEditorMessage {
  /** Absolute local file path. */
  file: string;
  /** 1-based line. 0/undefined means "no explicit selection". */
  line?: number;
  /** 1-based column. Only meaningful together with `line`. */
  character?: number;
}

export type OpenInEditorParseResult =
  | { ok: true; value: OpenInEditorMessage }
  | { ok: false; reason: string };

function parseOptionalLineColumn(
  record: Record<string, unknown>,
  key: 'line' | 'character',
): number | undefined | string {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return `${key} must be a non-negative integer`;
  }
  return value;
}

/**
 * Validate a webview `dsh.openInEditor` message. Returns the normalized
 * message or a human-readable rejection reason.
 */
export function parseOpenInEditorMessage(value: unknown): OpenInEditorParseResult {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'message must be an object' };
  }
  const record = value as Record<string, unknown>;
  if (record.type !== OPEN_IN_EDITOR_MESSAGE_TYPE) {
    return { ok: false, reason: `expected type "${OPEN_IN_EDITOR_MESSAGE_TYPE}"` };
  }
  if (typeof record.file !== 'string' || record.file.trim() === '') {
    return { ok: false, reason: 'file must be a non-empty string' };
  }
  if (!path.isAbsolute(record.file)) {
    return { ok: false, reason: `file must be an absolute path: ${record.file}` };
  }

  const line = parseOptionalLineColumn(record, 'line');
  if (typeof line === 'string') return { ok: false, reason: line };
  const character = parseOptionalLineColumn(record, 'character');
  if (typeof character === 'string') return { ok: false, reason: character };
  if (character !== undefined && line === undefined) {
    return { ok: false, reason: 'character requires line' };
  }

  return {
    ok: true,
    value: {
      file: record.file,
      ...(line === undefined ? {} : { line }),
      ...(character === undefined ? {} : { character }),
    },
  };
}
