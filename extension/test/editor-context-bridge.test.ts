import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createEditorContextErrorResponse,
  createEditorContextSuccessResponse,
  EDITOR_CONTEXT_REQUEST_MESSAGE_TYPE,
  EDITOR_CONTEXT_RESPONSE_MESSAGE_TYPE,
  MAX_EDITOR_CONTEXT_REQUEST_ID_CHARS,
  MAX_EDITOR_CONTEXT_SESSION_ID_CHARS,
  parseEditorContextRequestMessage,
} from '../src/editor-context-bridge';
import { EditorContextSnapshot } from '../src/editor-context';

const request = {
  type: EDITOR_CONTEXT_REQUEST_MESSAGE_TYPE,
  requestId: 'request-123',
  sessionId: 'session:abc',
} as const;

const context: EditorContextSnapshot = {
  version: 1,
  file: 'C:\\work\\sample.ts',
  uri: 'file:///c%3A/work/sample.ts',
  languageId: 'typescript',
  documentVersion: 3,
  isDirty: false,
  cursor: { line: 2, character: 4 },
};

describe('parseEditorContextRequestMessage', () => {
  it('accepts and detaches an exact requestId/sessionId request', () => {
    const parsed = parseEditorContextRequestMessage(request);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.value, request);
      assert.notEqual(parsed.value, request);
    }
  });

  it('rejects malformed, extra-field, whitespace, control, and oversized ids', () => {
    const cases: unknown[] = [
      null,
      { ...request, type: 'dsh.retry' },
      { ...request, extra: true },
      { type: request.type, requestId: '', sessionId: request.sessionId },
      { ...request, requestId: ' padded ' },
      { ...request, sessionId: 'bad\nvalue' },
      { ...request, requestId: 'r'.repeat(MAX_EDITOR_CONTEXT_REQUEST_ID_CHARS + 1) },
      { ...request, sessionId: 's'.repeat(MAX_EDITOR_CONTEXT_SESSION_ID_CHARS + 1) },
    ];
    for (const value of cases) assert.equal(parseEditorContextRequestMessage(value).ok, false);
  });
});

describe('editor context responses', () => {
  it('echoes request/session identity with the successful context', () => {
    assert.deepEqual(createEditorContextSuccessResponse(request, context), {
      type: EDITOR_CONTEXT_RESPONSE_MESSAGE_TYPE,
      requestId: request.requestId,
      sessionId: request.sessionId,
      ok: true,
      context,
    });
  });

  it('returns a structured error without inventing a different session', () => {
    assert.deepEqual(
      createEditorContextErrorResponse(request, 'NO_EDITOR_CONTEXT', 'No editor.'),
      {
        type: EDITOR_CONTEXT_RESPONSE_MESSAGE_TYPE,
        requestId: request.requestId,
        sessionId: request.sessionId,
        ok: false,
        error: { code: 'NO_EDITOR_CONTEXT', message: 'No editor.' },
      },
    );
  });
});
