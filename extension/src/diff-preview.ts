/** Pure Phase 2C protocol for requesting a read-only VS Code diff preview. */
import * as path from 'node:path';

export const DIFF_PREVIEW_MESSAGE_TYPE = 'dsh.previewDiff';
export const MAX_DIFF_PREVIEW_FILE_CHARS = 32_768;
export const MAX_DIFF_PREVIEW_HUNKS = 200;
export const MAX_DIFF_PREVIEW_TEXT_CHARS_PER_HUNK = 262_144;
export const MAX_DIFF_PREVIEW_TOTAL_TEXT_CHARS = 1_048_576;

/** One contextual before/after hunk supplied by DSH's persisted FileDiff metadata. */
export interface DiffPreviewHunk {
  /** Null denotes a newly created file with no prior text. */
  oldText: string | null;
  newText: string;
}

export interface DiffPreviewMessage {
  type: typeof DIFF_PREVIEW_MESSAGE_TYPE;
  /** Absolute local path resolved by the DSH client against its session workspace. */
  file: string;
  /** Non-empty contextual hunks for one file, in source order. */
  diffs: DiffPreviewHunk[];
}

export type DiffPreviewParseResult =
  | { ok: true; value: DiffPreviewMessage }
  | { ok: false; reason: string };

export interface DiffPreviewDocuments {
  original: string;
  modified: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unexpectedOrMissingKey(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): string | undefined {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) return `unexpected ${key}`;
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return `missing ${key}`;
  }
  return undefined;
}

function validateFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) {
    return 'file must be a non-empty trimmed string';
  }
  if (value.length > MAX_DIFF_PREVIEW_FILE_CHARS) return 'file is too long';
  if (/\0|\r|\n/u.test(value)) return 'file contains a forbidden control character';
  if (!path.isAbsolute(value)) return `file must be an absolute path: ${value}`;
  return undefined;
}

/**
 * Validate and detach a parent-webview diff request before any VS Code API can
 * consume it. Limits are measured in JavaScript UTF-16 code units and bound
 * both individual hunks and the complete IPC payload.
 */
export function parseDiffPreviewMessage(value: unknown): DiffPreviewParseResult {
  if (!isRecord(value)) return { ok: false, reason: 'message must be an object' };

  const messageKeyError = unexpectedOrMissingKey(value, ['type', 'file', 'diffs']);
  if (messageKeyError !== undefined) return { ok: false, reason: messageKeyError };
  if (value.type !== DIFF_PREVIEW_MESSAGE_TYPE) {
    return { ok: false, reason: `expected type "${DIFF_PREVIEW_MESSAGE_TYPE}"` };
  }

  const fileError = validateFile(value.file);
  if (fileError !== undefined) return { ok: false, reason: fileError };
  if (!Array.isArray(value.diffs) || value.diffs.length === 0) {
    return { ok: false, reason: 'diffs must be a non-empty array' };
  }
  if (value.diffs.length > MAX_DIFF_PREVIEW_HUNKS) {
    return { ok: false, reason: 'diffs contains too many hunks' };
  }

  let totalTextChars = 0;
  const diffs: DiffPreviewHunk[] = [];
  for (let index = 0; index < value.diffs.length; index += 1) {
    const candidate: unknown = value.diffs[index];
    if (!isRecord(candidate)) {
      return { ok: false, reason: `diffs[${index}] must be an object` };
    }
    const hunkKeyError = unexpectedOrMissingKey(candidate, ['oldText', 'newText']);
    if (hunkKeyError !== undefined) {
      return { ok: false, reason: `diffs[${index}]: ${hunkKeyError}` };
    }
    if (candidate.oldText !== null && typeof candidate.oldText !== 'string') {
      return { ok: false, reason: `diffs[${index}].oldText must be a string or null` };
    }
    if (typeof candidate.newText !== 'string') {
      return { ok: false, reason: `diffs[${index}].newText must be a string` };
    }

    const oldText = candidate.oldText as string | null;
    const newText = candidate.newText;
    const hunkTextChars = (oldText?.length ?? 0) + newText.length;
    if (hunkTextChars > MAX_DIFF_PREVIEW_TEXT_CHARS_PER_HUNK) {
      return { ok: false, reason: `diffs[${index}] text is too large` };
    }
    totalTextChars += hunkTextChars;
    if (totalTextChars > MAX_DIFF_PREVIEW_TOTAL_TEXT_CHARS) {
      return { ok: false, reason: 'diff text is too large in total' };
    }
    diffs.push({ oldText, newText });
  }

  return {
    ok: true,
    value: {
      type: DIFF_PREVIEW_MESSAGE_TYPE,
      file: value.file as string,
      diffs,
    },
  };
}

/**
 * Build the two virtual, read-only documents consumed by VS Code's diff
 * editor. DSH supplies contextual hunks rather than whole-file snapshots, so
 * blank lines separate multiple hunks on both sides without inventing source
 * text or touching the workspace file.
 */
export function buildDiffPreviewDocuments(
  diffs: readonly DiffPreviewHunk[],
): DiffPreviewDocuments {
  return {
    original: diffs.map((diff) => diff.oldText ?? '').join('\n\n'),
    modified: diffs.map((diff) => diff.newText).join('\n\n'),
  };
}
