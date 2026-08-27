/** Pure Phase 2B webview request/response protocol. */
import { EditorContextSnapshot } from './editor-context';

export const EDITOR_CONTEXT_REQUEST_MESSAGE_TYPE = 'dsh.requestEditorContext';
export const EDITOR_CONTEXT_RESPONSE_MESSAGE_TYPE = 'dsh.editorContext';
export const MAX_EDITOR_CONTEXT_REQUEST_ID_CHARS = 128;
export const MAX_EDITOR_CONTEXT_SESSION_ID_CHARS = 512;

export interface EditorContextRequestMessage {
  type: typeof EDITOR_CONTEXT_REQUEST_MESSAGE_TYPE;
  requestId: string;
  /** Exact DSH session selected when the iframe initiated the request. */
  sessionId: string;
}

export type EditorContextRequestParseResult =
  | { ok: true; value: EditorContextRequestMessage }
  | { ok: false; reason: string };

export type EditorContextErrorCode = 'NO_EDITOR_CONTEXT' | 'EDITOR_CONTEXT_READ_FAILED';

export type EditorContextResponseMessage =
  | {
      type: typeof EDITOR_CONTEXT_RESPONSE_MESSAGE_TYPE;
      requestId: string;
      sessionId: string;
      ok: true;
      context: EditorContextSnapshot;
    }
  | {
      type: typeof EDITOR_CONTEXT_RESPONSE_MESSAGE_TYPE;
      requestId: string;
      sessionId: string;
      ok: false;
      error: { code: EditorContextErrorCode; message: string };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateOpaqueId(value: unknown, name: string, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) {
    return `${name} must be a non-empty trimmed string`;
  }
  if (value.length > maxLength) return `${name} is too long`;
  if (/\0|\r|\n/u.test(value)) return `${name} contains a forbidden control character`;
  return undefined;
}

/** Validate the parent-webview request before it can read editor state. */
export function parseEditorContextRequestMessage(value: unknown): EditorContextRequestParseResult {
  if (!isRecord(value)) return { ok: false, reason: 'message must be an object' };
  const keys = Object.keys(value);
  const expected = new Set(['type', 'requestId', 'sessionId']);
  for (const key of keys) {
    if (!expected.has(key)) return { ok: false, reason: `unexpected ${key}` };
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return { ok: false, reason: `missing ${key}` };
  }
  if (value.type !== EDITOR_CONTEXT_REQUEST_MESSAGE_TYPE) {
    return { ok: false, reason: `expected type "${EDITOR_CONTEXT_REQUEST_MESSAGE_TYPE}"` };
  }
  const requestError = validateOpaqueId(
    value.requestId,
    'requestId',
    MAX_EDITOR_CONTEXT_REQUEST_ID_CHARS,
  );
  if (requestError !== undefined) return { ok: false, reason: requestError };
  const sessionError = validateOpaqueId(
    value.sessionId,
    'sessionId',
    MAX_EDITOR_CONTEXT_SESSION_ID_CHARS,
  );
  if (sessionError !== undefined) return { ok: false, reason: sessionError };

  return {
    ok: true,
    value: {
      type: EDITOR_CONTEXT_REQUEST_MESSAGE_TYPE,
      requestId: value.requestId as string,
      sessionId: value.sessionId as string,
    },
  };
}

export function createEditorContextSuccessResponse(
  request: EditorContextRequestMessage,
  context: EditorContextSnapshot,
): EditorContextResponseMessage {
  return {
    type: EDITOR_CONTEXT_RESPONSE_MESSAGE_TYPE,
    requestId: request.requestId,
    sessionId: request.sessionId,
    ok: true,
    context,
  };
}

export function createEditorContextErrorResponse(
  request: EditorContextRequestMessage,
  code: EditorContextErrorCode,
  message: string,
): EditorContextResponseMessage {
  return {
    type: EDITOR_CONTEXT_RESPONSE_MESSAGE_TYPE,
    requestId: request.requestId,
    sessionId: request.sessionId,
    ok: false,
    error: { code, message },
  };
}
