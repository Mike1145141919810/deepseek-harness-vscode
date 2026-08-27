import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildEditorContextSnapshot,
  EDITOR_CONTEXT_VERSION,
  MAX_EDITOR_SELECTION_CHARS,
} from '../src/editor-context';

const base = {
  file: 'C:\\work\\src\\sample.ts',
  uri: 'file:///c%3A/work/src/sample.ts',
  languageId: 'typescript',
  documentVersion: 7,
  isDirty: true,
  cursor: { line: 4, character: 2 },
};

describe('buildEditorContextSnapshot', () => {
  it('builds a JSON-safe snapshot and converts positions to 1-based values', () => {
    const snapshot = buildEditorContextSnapshot({
      ...base,
      selection: {
        start: { line: 1, character: 3 },
        end: { line: 2, character: 5 },
        text: 'selected text',
      },
    });

    assert.equal(snapshot.version, EDITOR_CONTEXT_VERSION);
    assert.equal(snapshot.file, base.file);
    assert.equal(snapshot.uri, base.uri);
    assert.equal(snapshot.languageId, 'typescript');
    assert.equal(snapshot.documentVersion, 7);
    assert.equal(snapshot.isDirty, true);
    assert.deepEqual(snapshot.cursor, { line: 5, character: 3 });
    assert.deepEqual(snapshot.selection, {
      start: { line: 2, character: 4 },
      end: { line: 3, character: 6 },
      text: 'selected text',
      truncated: false,
    });
    assert.doesNotThrow(() => JSON.stringify(snapshot));
  });

  it('omits selection and document text when the selection is empty', () => {
    const snapshot = buildEditorContextSnapshot(base);
    assert.equal(snapshot.selection, undefined);
    assert.deepEqual(snapshot.cursor, { line: 5, character: 3 });
  });

  it('bounds selected text and reports truncation', () => {
    const text = 'x'.repeat(MAX_EDITOR_SELECTION_CHARS + 10);
    const snapshot = buildEditorContextSnapshot({
      ...base,
      selection: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: text.length },
        text,
      },
    });
    assert.equal(snapshot.selection?.text.length, MAX_EDITOR_SELECTION_CHARS);
    assert.equal(snapshot.selection?.truncated, true);

    const exact = buildEditorContextSnapshot(
      {
        ...base,
        selection: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
          text: 'abcd',
        },
      },
      4,
    );
    assert.equal(exact.selection?.text, 'abcd');
    assert.equal(exact.selection?.truncated, false);
  });

  it('rejects invalid source data and size limits', () => {
    assert.throws(() => buildEditorContextSnapshot({ ...base, file: '' }), /file must not be empty/);
    assert.throws(() => buildEditorContextSnapshot({ ...base, cursor: { line: -1, character: 0 } }), /positions/);
    assert.throws(() => buildEditorContextSnapshot(base, 0), /positive integer/);
  });
});
