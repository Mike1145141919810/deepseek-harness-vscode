import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  DIFF_PREVIEW_MESSAGE_TYPE,
  MAX_DIFF_PREVIEW_FILE_CHARS,
  MAX_DIFF_PREVIEW_HUNKS,
  MAX_DIFF_PREVIEW_TEXT_CHARS_PER_HUNK,
  MAX_DIFF_PREVIEW_TOTAL_TEXT_CHARS,
  buildDiffPreviewDocuments,
  parseDiffPreviewMessage,
} from '../src/diff-preview';

const absolute = path.resolve('workspace', 'sample.ts');
const valid = {
  type: DIFF_PREVIEW_MESSAGE_TYPE,
  file: absolute,
  diffs: [
    { oldText: 'const answer = 41;\n', newText: 'const answer = 42;\n' },
    { oldText: null, newText: 'export { answer };\n' },
  ],
};

describe('parseDiffPreviewMessage', () => {
  it('accepts and detaches valid contextual hunks for one absolute file', () => {
    const parsed = parseDiffPreviewMessage(valid);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.value, valid);
      assert.notEqual(parsed.value, valid);
      assert.notEqual(parsed.value.diffs, valid.diffs);
      assert.notEqual(parsed.value.diffs[0], valid.diffs[0]);
    }
  });

  it('accepts empty text for a deletion or empty-file creation', () => {
    assert.equal(
      parseDiffPreviewMessage({
        ...valid,
        diffs: [
          { oldText: 'removed\n', newText: '' },
          { oldText: null, newText: '' },
        ],
      }).ok,
      true,
    );
  });

  it('rejects malformed messages and any extra or missing root field', () => {
    const cases: unknown[] = [
      null,
      [],
      { ...valid, type: 'dsh.openInEditor' },
      { ...valid, extra: true },
      { type: valid.type, file: valid.file },
    ];
    for (const value of cases) assert.equal(parseDiffPreviewMessage(value).ok, false);
  });

  it('rejects empty, padded, relative, controlled, non-string, and oversized paths', () => {
    const files: unknown[] = [
      '',
      ` ${absolute}`,
      'relative/sample.ts',
      `${absolute}\nspoofed.ts`,
      42,
      path.parse(absolute).root + 'x'.repeat(MAX_DIFF_PREVIEW_FILE_CHARS),
    ];
    for (const file of files) {
      assert.equal(parseDiffPreviewMessage({ ...valid, file }).ok, false);
    }
  });

  it('rejects an empty, non-array, or overlong hunk list', () => {
    assert.equal(parseDiffPreviewMessage({ ...valid, diffs: [] }).ok, false);
    assert.equal(parseDiffPreviewMessage({ ...valid, diffs: {} }).ok, false);
    assert.equal(
      parseDiffPreviewMessage({
        ...valid,
        diffs: Array.from({ length: MAX_DIFF_PREVIEW_HUNKS + 1 }, () => ({
          oldText: '',
          newText: '',
        })),
      }).ok,
      false,
    );
  });

  it('rejects malformed hunks and unknown hunk fields', () => {
    const diffs: unknown[] = [
      [null],
      [{ oldText: 'before' }],
      [{ oldText: false, newText: 'after' }],
      [{ oldText: 'before', newText: null }],
      [{ oldText: 'before', newText: 'after', path: absolute }],
    ];
    for (const value of diffs) {
      assert.equal(parseDiffPreviewMessage({ ...valid, diffs: value }).ok, false);
    }
  });

  it('bounds both per-hunk and aggregate text size', () => {
    assert.equal(
      parseDiffPreviewMessage({
        ...valid,
        diffs: [{ oldText: null, newText: 'x'.repeat(MAX_DIFF_PREVIEW_TEXT_CHARS_PER_HUNK + 1) }],
      }).ok,
      false,
    );

    const perHunk = Math.floor(MAX_DIFF_PREVIEW_TOTAL_TEXT_CHARS / 5);
    assert.ok(perHunk < MAX_DIFF_PREVIEW_TEXT_CHARS_PER_HUNK);
    assert.equal(
      parseDiffPreviewMessage({
        ...valid,
        diffs: Array.from({ length: 6 }, () => ({ oldText: null, newText: 'x'.repeat(perHunk) })),
      }).ok,
      false,
    );
  });
});

describe('buildDiffPreviewDocuments', () => {
  it('creates in-memory before/after documents without reading the real file', () => {
    assert.deepEqual(buildDiffPreviewDocuments(valid.diffs), {
      original: 'const answer = 41;\n\n\n',
      modified: 'const answer = 42;\n\n\nexport { answer };\n',
    });
  });

  it('preserves deletion text on the original side', () => {
    assert.deepEqual(
      buildDiffPreviewDocuments([{ oldText: 'removed\n', newText: '' }]),
      { original: 'removed\n', modified: '' },
    );
  });
});
