/**
 * Serializable Phase 2B snapshot of the last local file editor.
 *
 * Positions on the wire are 1-based for human/model readability. The VS Code
 * adapter supplies 0-based positions and this pure module owns the conversion,
 * selection-size bound, and DTO shape so it can be tested without `vscode`.
 */

export const EDITOR_CONTEXT_VERSION = 1 as const;
export const MAX_EDITOR_SELECTION_CHARS = 16_384;

export interface EditorContextPosition {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  character: number;
}

export interface EditorContextSelection {
  start: EditorContextPosition;
  end: EditorContextPosition;
  text: string;
  /** True when `text` was shortened to MAX_EDITOR_SELECTION_CHARS. */
  truncated: boolean;
}

export interface EditorContextSnapshot {
  version: typeof EDITOR_CONTEXT_VERSION;
  /** Absolute path of the local file. */
  file: string;
  /** Canonical file URI retained alongside the platform-native path. */
  uri: string;
  languageId: string;
  documentVersion: number;
  isDirty: boolean;
  cursor: EditorContextPosition;
  /** Omitted for an empty selection; the whole document is never copied. */
  selection?: EditorContextSelection;
}

export interface ZeroBasedEditorPosition {
  line: number;
  character: number;
}

export interface EditorContextSource {
  file: string;
  uri: string;
  languageId: string;
  documentVersion: number;
  isDirty: boolean;
  cursor: ZeroBasedEditorPosition;
  selection?: {
    start: ZeroBasedEditorPosition;
    end: ZeroBasedEditorPosition;
    text: string;
    /** Upstream adapter already bounded the materialized text. */
    truncated?: boolean;
  };
}

function toOneBased(position: ZeroBasedEditorPosition): EditorContextPosition {
  if (
    !Number.isInteger(position.line) ||
    position.line < 0 ||
    !Number.isInteger(position.character) ||
    position.character < 0
  ) {
    throw new TypeError('editor positions must be non-negative integers');
  }
  return { line: position.line + 1, character: position.character + 1 };
}

/**
 * Build a bounded, JSON-safe editor snapshot. Empty selections deliberately
 * omit document text: Phase 2B is explicit context sharing, not background
 * whole-file collection.
 */
export function buildEditorContextSnapshot(
  source: EditorContextSource,
  maxSelectionChars = MAX_EDITOR_SELECTION_CHARS,
): EditorContextSnapshot {
  if (source.file.trim() === '') throw new TypeError('file must not be empty');
  if (source.uri.trim() === '') throw new TypeError('uri must not be empty');
  if (!Number.isInteger(maxSelectionChars) || maxSelectionChars < 1) {
    throw new TypeError('maxSelectionChars must be a positive integer');
  }

  const selection = source.selection;
  const boundedSelection = selection === undefined
    ? undefined
    : {
        start: toOneBased(selection.start),
        end: toOneBased(selection.end),
        text: selection.text.slice(0, maxSelectionChars),
        truncated: selection.truncated === true || selection.text.length > maxSelectionChars,
      };

  return {
    version: EDITOR_CONTEXT_VERSION,
    file: source.file,
    uri: source.uri,
    languageId: source.languageId,
    documentVersion: source.documentVersion,
    isDirty: source.isDirty,
    cursor: toOneBased(source.cursor),
    ...(boundedSelection === undefined ? {} : { selection: boundedSelection }),
  };
}
