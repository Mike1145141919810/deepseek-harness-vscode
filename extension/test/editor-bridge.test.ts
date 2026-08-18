import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { OPEN_IN_EDITOR_MESSAGE_TYPE, parseOpenInEditorMessage } from '../src/editor-bridge';

const absolute = path.isAbsolute('C:/x') ? 'C:/x/file.ts' : '/tmp/file.ts';

describe('parseOpenInEditorMessage', () => {
  it('accepts a valid absolute file path with no selection', () => {
    const parsed = parseOpenInEditorMessage({ type: OPEN_IN_EDITOR_MESSAGE_TYPE, file: absolute });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.file, absolute);
      assert.equal(parsed.value.line, undefined);
    }
  });

  it('accepts 1-based line and character', () => {
    const parsed = parseOpenInEditorMessage({
      type: OPEN_IN_EDITOR_MESSAGE_TYPE,
      file: absolute,
      line: 42,
      character: 7,
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.line, 42);
      assert.equal(parsed.value.character, 7);
    }
  });

  it('rejects non-object payloads and wrong types', () => {
    assert.equal(parseOpenInEditorMessage(null).ok, false);
    assert.equal(parseOpenInEditorMessage('nope').ok, false);
    assert.equal(parseOpenInEditorMessage({ type: 'dsh.retry', file: absolute }).ok, false);
  });

  it('rejects empty, relative, and non-string files', () => {
    assert.equal(parseOpenInEditorMessage({ type: OPEN_IN_EDITOR_MESSAGE_TYPE, file: '' }).ok, false);
    assert.equal(parseOpenInEditorMessage({ type: OPEN_IN_EDITOR_MESSAGE_TYPE, file: 'relative/path.ts' }).ok, false);
    assert.equal(parseOpenInEditorMessage({ type: OPEN_IN_EDITOR_MESSAGE_TYPE, file: 42 }).ok, false);
  });

  it('rejects malformed line/character', () => {
    assert.equal(
      parseOpenInEditorMessage({ type: OPEN_IN_EDITOR_MESSAGE_TYPE, file: absolute, line: 1.5 }).ok,
      false,
    );
    assert.equal(
      parseOpenInEditorMessage({ type: OPEN_IN_EDITOR_MESSAGE_TYPE, file: absolute, line: -1 }).ok,
      false,
    );
    assert.equal(
      parseOpenInEditorMessage({ type: OPEN_IN_EDITOR_MESSAGE_TYPE, file: absolute, line: '1' }).ok,
      false,
    );
    assert.equal(
      parseOpenInEditorMessage({ type: OPEN_IN_EDITOR_MESSAGE_TYPE, file: absolute, character: 1 }).ok,
      false,
    );
  });
});
