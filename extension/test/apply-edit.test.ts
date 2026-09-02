import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  APPLY_EDIT_PROTOCOL_VERSION,
  APPLY_EDIT_REQUEST_MESSAGE_TYPE,
  APPLY_EDIT_REQUEST_TTL_MS,
  ApplyEditRequestGate,
  MAX_APPLY_EDIT_FILE_CHARS,
  MAX_APPLY_EDIT_REQUEST_ID_CHARS,
  MAX_APPLY_EDIT_SESSION_ID_CHARS,
  MAX_APPLY_EDIT_TEXT_CHARS,
  parseApplyEditRequestMessage,
  parseApplyEditRequestIdentity,
  sha256ApplyEditText,
  validateApplyEditPrecondition,
  validateWorkspacePath,
} from '../src/apply-edit';

const absolute = path.resolve('workspace', 'sample.ts');
const beforeText = 'const answer = 41;\n';
const valid = {
  type: APPLY_EDIT_REQUEST_MESSAGE_TYPE,
  version: APPLY_EDIT_PROTOCOL_VERSION,
  requestId: 'request-123',
  sessionId: 'session:abc',
  file: absolute,
  beforeSha256: sha256ApplyEditText(beforeText),
  beforeText,
  afterText: 'const answer = 42;\n',
} as const;

function parseWith(changes: Record<string, unknown>) {
  return parseApplyEditRequestMessage({ ...valid, ...changes });
}

describe('parseApplyEditRequestMessage', () => {
  it('accepts and detaches one exact, versioned full-file replacement', () => {
    const parsed = parseApplyEditRequestMessage(valid);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.value, valid);
      assert.notEqual(parsed.value, valid);
    }
  });

  it('defines SHA-256 over UTF-8 text, including non-ASCII content', () => {
    assert.equal(
      sha256ApplyEditText('你好\n'),
      '4e0826721642ed8e3a27e7147538ac7b7013a08fe5ae343a8ef09749b7e5790f',
    );
  });

  it('rejects malformed roots, unknown fields, missing fields, and protocol drift', () => {
    const cases: unknown[] = [
      null,
      [],
      { ...valid, type: 'dsh.previewDiff' },
      { ...valid, version: 2 },
      { ...valid, extra: true },
      {
        type: valid.type,
        version: valid.version,
        requestId: valid.requestId,
        sessionId: valid.sessionId,
        file: valid.file,
        beforeSha256: valid.beforeSha256,
        beforeText: valid.beforeText,
      },
    ];
    for (const value of cases) assert.equal(parseApplyEditRequestMessage(value).ok, false);
  });

  it('rejects malformed, controlled, and oversized identities', () => {
    const cases: Record<string, unknown>[] = [
      { requestId: '' },
      { requestId: ' padded ' },
      { requestId: 'bad\tvalue' },
      { sessionId: 'bad\nvalue' },
      { requestId: 'r'.repeat(MAX_APPLY_EDIT_REQUEST_ID_CHARS + 1) },
      { sessionId: 's'.repeat(MAX_APPLY_EDIT_SESSION_ID_CHARS + 1) },
    ];
    for (const changes of cases) assert.equal(parseWith(changes).ok, false);
  });

  it('rejects empty, padded, relative, controlled, non-string, and oversized paths', () => {
    const files: unknown[] = [
      '',
      ` ${absolute}`,
      'relative/sample.ts',
      `${absolute}\nspoofed.ts`,
      42,
      path.parse(absolute).root + 'x'.repeat(MAX_APPLY_EDIT_FILE_CHARS),
    ];
    for (const file of files) assert.equal(parseWith({ file }).ok, false);
  });

  it('rejects invalid or mismatched preimage digests', () => {
    const digests: unknown[] = [
      '',
      'A'.repeat(64),
      '0'.repeat(63),
      42,
      sha256ApplyEditText('different'),
    ];
    for (const beforeSha256 of digests) {
      assert.equal(parseWith({ beforeSha256 }).ok, false);
    }
  });

  it('rejects non-string, NUL-bearing, oversized, and no-op text', () => {
    const cases: Record<string, unknown>[] = [
      { beforeText: null },
      { afterText: null },
      { beforeText: 'before\0text', beforeSha256: sha256ApplyEditText('before\0text') },
      { afterText: 'after\0text' },
      {
        beforeText: 'x'.repeat(MAX_APPLY_EDIT_TEXT_CHARS + 1),
        beforeSha256: sha256ApplyEditText('x'.repeat(MAX_APPLY_EDIT_TEXT_CHARS + 1)),
      },
      { afterText: 'x'.repeat(MAX_APPLY_EDIT_TEXT_CHARS + 1) },
      { afterText: beforeText },
    ];
    for (const changes of cases) assert.equal(parseWith(changes).ok, false);
  });

  it('accepts empty before or after text when the replacement is not a no-op', () => {
    assert.equal(
      parseWith({ beforeText: '', beforeSha256: sha256ApplyEditText('') }).ok,
      true,
    );
    assert.equal(parseWith({ afterText: '' }).ok, true);
  });
});

describe('parseApplyEditRequestIdentity', () => {
  it('recovers only bounded correlation fields from an otherwise malformed proposal', () => {
    assert.deepEqual(parseApplyEditRequestIdentity({ ...valid, afterText: null, extra: true }), {
      ok: true,
      value: { requestId: valid.requestId, sessionId: valid.sessionId },
    });
    assert.equal(parseApplyEditRequestIdentity({ ...valid, requestId: ' bad ' }).ok, false);
    assert.equal(parseApplyEditRequestIdentity({ ...valid, type: 'other' }).ok, false);
  });
});

describe('validateWorkspacePath', () => {
  it('accepts a descendant whose lexical and canonical paths share one workspace', () => {
    const folder = { folderPath: '/work/project', folderRealPath: '/disk/project' };
    assert.deepEqual(
      validateWorkspacePath(
        '/work/project/src/file.ts',
        '/disk/project/src/file.ts',
        [folder],
        'posix',
      ),
      { ok: true, workspaceFolder: folder },
    );
  });

  it('rejects lexical siblings, the workspace directory itself, and relative paths', () => {
    const folder = { folderPath: '/work/project', folderRealPath: '/work/project' };
    for (const file of ['/work/project-other/file.ts', '/work/project', 'project/file.ts']) {
      assert.deepEqual(validateWorkspacePath(file, file, [folder], 'posix'), {
        ok: false,
        code: 'OUTSIDE_WORKSPACE',
      });
    }
  });

  it('rejects a symlink whose presented target is inside but real target escapes', () => {
    assert.deepEqual(
      validateWorkspacePath(
        '/work/project/link/secret.ts',
        '/outside/secret.ts',
        [{ folderPath: '/work/project', folderRealPath: '/real/project' }],
        'posix',
      ),
      { ok: false, code: 'SYMLINK_ESCAPE' },
    );
  });

  it('uses Windows path rules and accepts case-only differences', () => {
    const folder = { folderPath: 'C:\\Work\\Project', folderRealPath: 'D:\\Real\\Project' };
    assert.deepEqual(
      validateWorkspacePath(
        'c:\\work\\project\\src\\file.ts',
        'd:\\real\\project\\SRC\\file.ts',
        [folder],
        'win32',
      ),
      { ok: true, workspaceFolder: folder },
    );
  });

  it('accepts a target through the matching root in a multi-root workspace', () => {
    const first = { folderPath: '/work/a', folderRealPath: '/real/a' };
    const second = { folderPath: '/work/b', folderRealPath: '/real/b' };
    assert.deepEqual(
      validateWorkspacePath('/work/b/file.ts', '/real/b/file.ts', [first, second], 'posix'),
      { ok: true, workspaceFolder: second },
    );
  });
});

describe('validateApplyEditPrecondition', () => {
  it('accepts a clean exact preimage and the captured document version', () => {
    assert.deepEqual(
      validateApplyEditPrecondition(valid, { text: beforeText, version: 7, isDirty: false }, 7),
      { ok: true },
    );
  });

  it('rejects dirty documents before considering their content', () => {
    assert.deepEqual(
      validateApplyEditPrecondition(valid, { text: beforeText, version: 7, isDirty: true }, 7),
      { ok: false, code: 'DIRTY_DOCUMENT' },
    );
  });

  it('rejects changed text or a changed version as a stale preimage', () => {
    assert.deepEqual(
      validateApplyEditPrecondition(valid, { text: 'changed', version: 7, isDirty: false }, 7),
      { ok: false, code: 'STALE_PREIMAGE' },
    );
    assert.deepEqual(
      validateApplyEditPrecondition(valid, { text: beforeText, version: 8, isDirty: false }, 7),
      { ok: false, code: 'STALE_PREIMAGE' },
    );
  });
});

describe('ApplyEditRequestGate', () => {
  it('allows one active request, rejects overlap, and permits the next after finish', () => {
    const gate = new ApplyEditRequestGate();
    assert.deepEqual(gate.begin('first', 1_000), {
      ok: true,
      expiresAt: 1_000 + APPLY_EDIT_REQUEST_TTL_MS,
    });
    assert.deepEqual(gate.begin('second', 1_001), {
      ok: false,
      code: 'REQUEST_IN_PROGRESS',
    });
    assert.equal(gate.finish('first'), true);
    assert.equal(gate.begin('second', 1_002).ok, true);
  });

  it('rejects a replayed ID even after its request finishes', () => {
    const gate = new ApplyEditRequestGate();
    assert.equal(gate.begin('same', 0).ok, true);
    assert.equal(gate.finish('same'), true);
    assert.deepEqual(gate.begin('same', 1), { ok: false, code: 'DUPLICATE_REQUEST' });
  });

  it('expires at the exact deadline and never revives the expired ID', () => {
    const gate = new ApplyEditRequestGate();
    assert.equal(gate.begin('old', 5_000).ok, true);
    assert.deepEqual(gate.assertActive('old', 5_000 + APPLY_EDIT_REQUEST_TTL_MS - 1), {
      ok: true,
    });
    assert.deepEqual(gate.assertActive('old', 5_000 + APPLY_EDIT_REQUEST_TTL_MS), {
      ok: false,
      code: 'REQUEST_EXPIRED',
    });
    assert.deepEqual(gate.begin('old', 999_999), {
      ok: false,
      code: 'DUPLICATE_REQUEST',
    });
    assert.equal(gate.begin('new', 999_999).ok, true);
  });

  it('does not finish or authorize a different request ID', () => {
    const gate = new ApplyEditRequestGate();
    assert.equal(gate.begin('active', 0).ok, true);
    assert.deepEqual(gate.assertActive('other', 1), {
      ok: false,
      code: 'REQUEST_NOT_ACTIVE',
    });
    assert.equal(gate.finish('other'), false);
    assert.deepEqual(gate.assertActive('active', 1), { ok: true });
  });
});
