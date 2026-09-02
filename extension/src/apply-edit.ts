/** Pure Phase 2D apply-edit protocol and safety predicates. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const APPLY_EDIT_REQUEST_MESSAGE_TYPE = 'dsh.requestApplyEdit';
export const APPLY_EDIT_RESPONSE_MESSAGE_TYPE = 'dsh.applyEditResult';
export const APPLY_EDIT_PROTOCOL_VERSION = 1;
export const MAX_APPLY_EDIT_REQUEST_ID_CHARS = 128;
export const MAX_APPLY_EDIT_SESSION_ID_CHARS = 512;
export const MAX_APPLY_EDIT_FILE_CHARS = 32_768;
export const MAX_APPLY_EDIT_TEXT_CHARS = 1_048_576;
export const APPLY_EDIT_REQUEST_TTL_MS = 120_000;

export interface ApplyEditRequestMessage {
  type: typeof APPLY_EDIT_REQUEST_MESSAGE_TYPE;
  version: typeof APPLY_EDIT_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  /** Absolute local path. Workspace and realpath checks happen separately. */
  file: string;
  /** Lowercase SHA-256 of beforeText encoded as UTF-8. */
  beforeSha256: string;
  beforeText: string;
  afterText: string;
}

export type ApplyEditRequestParseResult =
  | { ok: true; value: ApplyEditRequestMessage }
  | { ok: false; reason: string };

export type ApplyEditRequestIdentityResult =
  | { ok: true; value: { requestId: string; sessionId: string } }
  | { ok: false; reason: string };

export type ApplyEditSafetyErrorCode =
  | 'WORKSPACE_UNTRUSTED'
  | 'OUTSIDE_WORKSPACE'
  | 'SYMLINK_ESCAPE'
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_FILE'
  | 'DIRTY_DOCUMENT'
  | 'STALE_PREIMAGE'
  | 'INVALID_REQUEST'
  | 'DUPLICATE_REQUEST'
  | 'REQUEST_IN_PROGRESS'
  | 'REQUEST_EXPIRED'
  | 'REQUEST_NOT_ACTIVE'
  | 'USER_CANCELLED'
  | 'APPLY_FAILED';

export interface WorkspacePathIdentity {
  /** Workspace path as presented to VS Code. */
  folderPath: string;
  /** Canonical path returned by realpath for the same folder. */
  folderRealPath: string;
}

export type WorkspacePathResult =
  | { ok: true; workspaceFolder: WorkspacePathIdentity }
  | { ok: false; code: 'OUTSIDE_WORKSPACE' | 'SYMLINK_ESCAPE' };

export interface ApplyEditDocumentSnapshot {
  text: string;
  version: number;
  isDirty: boolean;
}

export type ApplyEditPreconditionResult =
  | { ok: true }
  | { ok: false; code: 'DIRTY_DOCUMENT' | 'STALE_PREIMAGE' };

export type ApplyEditRequestBeginResult =
  | { ok: true; expiresAt: number }
  | { ok: false; code: 'DUPLICATE_REQUEST' | 'REQUEST_IN_PROGRESS' };

export type ApplyEditRequestActiveResult =
  | { ok: true }
  | { ok: false; code: 'REQUEST_EXPIRED' | 'REQUEST_NOT_ACTIVE' };

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

function validateOpaqueId(value: unknown, name: string, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) {
    return `${name} must be a non-empty trimmed string`;
  }
  if (value.length > maxLength) return `${name} is too long`;
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return `${name} contains a forbidden control character`;
  }
  return undefined;
}

function validateFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) {
    return 'file must be a non-empty trimmed string';
  }
  if (value.length > MAX_APPLY_EDIT_FILE_CHARS) return 'file is too long';
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return 'file contains a forbidden control character';
  }
  if (!path.isAbsolute(value)) return `file must be an absolute path: ${value}`;
  return undefined;
}

/** SHA-256 over the UTF-8 representation used by the wire protocol. */
export function sha256ApplyEditText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Validate and detach a write proposal before any VS Code API can consume it. */
export function parseApplyEditRequestMessage(value: unknown): ApplyEditRequestParseResult {
  if (!isRecord(value)) return { ok: false, reason: 'message must be an object' };

  const keyError = unexpectedOrMissingKey(value, [
    'type',
    'version',
    'requestId',
    'sessionId',
    'file',
    'beforeSha256',
    'beforeText',
    'afterText',
  ]);
  if (keyError !== undefined) return { ok: false, reason: keyError };
  if (value.type !== APPLY_EDIT_REQUEST_MESSAGE_TYPE) {
    return { ok: false, reason: `expected type "${APPLY_EDIT_REQUEST_MESSAGE_TYPE}"` };
  }
  if (value.version !== APPLY_EDIT_PROTOCOL_VERSION) {
    return { ok: false, reason: `expected version ${APPLY_EDIT_PROTOCOL_VERSION}` };
  }

  const requestIdError = validateOpaqueId(
    value.requestId,
    'requestId',
    MAX_APPLY_EDIT_REQUEST_ID_CHARS,
  );
  if (requestIdError !== undefined) return { ok: false, reason: requestIdError };
  const sessionIdError = validateOpaqueId(
    value.sessionId,
    'sessionId',
    MAX_APPLY_EDIT_SESSION_ID_CHARS,
  );
  if (sessionIdError !== undefined) return { ok: false, reason: sessionIdError };
  const fileError = validateFile(value.file);
  if (fileError !== undefined) return { ok: false, reason: fileError };

  if (typeof value.beforeSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.beforeSha256)) {
    return { ok: false, reason: 'beforeSha256 must be a lowercase SHA-256 digest' };
  }
  if (typeof value.beforeText !== 'string') {
    return { ok: false, reason: 'beforeText must be a string' };
  }
  if (typeof value.afterText !== 'string') {
    return { ok: false, reason: 'afterText must be a string' };
  }
  if (value.beforeText.length > MAX_APPLY_EDIT_TEXT_CHARS) {
    return { ok: false, reason: 'beforeText is too large' };
  }
  if (value.afterText.length > MAX_APPLY_EDIT_TEXT_CHARS) {
    return { ok: false, reason: 'afterText is too large' };
  }
  if (value.beforeText.includes('\0') || value.afterText.includes('\0')) {
    return { ok: false, reason: 'file text contains a forbidden NUL character' };
  }
  if (value.beforeText === value.afterText) {
    return { ok: false, reason: 'edit must change the file text' };
  }
  if (sha256ApplyEditText(value.beforeText) !== value.beforeSha256) {
    return { ok: false, reason: 'beforeSha256 does not match beforeText' };
  }

  return {
    ok: true,
    value: {
      type: APPLY_EDIT_REQUEST_MESSAGE_TYPE,
      version: APPLY_EDIT_PROTOCOL_VERSION,
      requestId: value.requestId as string,
      sessionId: value.sessionId as string,
      file: value.file as string,
      beforeSha256: value.beforeSha256,
      beforeText: value.beforeText,
      afterText: value.afterText,
    },
  };
}

/** Recover only safe correlation fields so malformed proposals can get a bounded error. */
export function parseApplyEditRequestIdentity(value: unknown): ApplyEditRequestIdentityResult {
  if (!isRecord(value) || value.type !== APPLY_EDIT_REQUEST_MESSAGE_TYPE) {
    return { ok: false, reason: `expected type "${APPLY_EDIT_REQUEST_MESSAGE_TYPE}"` };
  }
  const requestIdError = validateOpaqueId(
    value.requestId,
    'requestId',
    MAX_APPLY_EDIT_REQUEST_ID_CHARS,
  );
  if (requestIdError !== undefined) return { ok: false, reason: requestIdError };
  const sessionIdError = validateOpaqueId(
    value.sessionId,
    'sessionId',
    MAX_APPLY_EDIT_SESSION_ID_CHARS,
  );
  if (sessionIdError !== undefined) return { ok: false, reason: sessionIdError };
  return {
    ok: true,
    value: {
      requestId: value.requestId as string,
      sessionId: value.sessionId as string,
    },
  };
}

function containsDescendant(
  pathApi: typeof path.win32 | typeof path.posix,
  root: string,
  candidate: string,
): boolean {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relative);
}

/**
 * Check both the presented paths and their separately obtained realpaths.
 * This function performs no I/O so callers can repeat it immediately before
 * applying an edit without hiding filesystem access in the policy layer.
 */
export function validateWorkspacePath(
  file: string,
  fileRealPath: string,
  workspaceFolders: readonly WorkspacePathIdentity[],
  flavor: 'win32' | 'posix' = process.platform === 'win32' ? 'win32' : 'posix',
): WorkspacePathResult {
  const pathApi = flavor === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(file) || !pathApi.isAbsolute(fileRealPath)) {
    return { ok: false, code: 'OUTSIDE_WORKSPACE' };
  }

  const lexicalMatches = workspaceFolders.filter((folder) =>
    pathApi.isAbsolute(folder.folderPath)
      && containsDescendant(pathApi, folder.folderPath, file),
  );
  if (lexicalMatches.length === 0) return { ok: false, code: 'OUTSIDE_WORKSPACE' };

  for (const folder of lexicalMatches) {
    if (
      pathApi.isAbsolute(folder.folderRealPath)
      && containsDescendant(pathApi, folder.folderRealPath, fileRealPath)
    ) {
      return { ok: true, workspaceFolder: folder };
    }
  }
  return { ok: false, code: 'SYMLINK_ESCAPE' };
}

/** Exact optimistic-concurrency check used before preview and again before apply. */
export function validateApplyEditPrecondition(
  request: ApplyEditRequestMessage,
  snapshot: ApplyEditDocumentSnapshot,
  expectedVersion?: number,
): ApplyEditPreconditionResult {
  if (snapshot.isDirty) return { ok: false, code: 'DIRTY_DOCUMENT' };
  if (expectedVersion !== undefined && snapshot.version !== expectedVersion) {
    return { ok: false, code: 'STALE_PREIMAGE' };
  }
  if (snapshot.text !== request.beforeText) {
    return { ok: false, code: 'STALE_PREIMAGE' };
  }
  return { ok: true };
}

/** Tracks one confirmation at a time and rejects replayed request IDs. */
export class ApplyEditRequestGate {
  private readonly seenRequestIds = new Set<string>();
  private pending: { requestId: string; expiresAt: number } | undefined;

  begin(requestId: string, now: number): ApplyEditRequestBeginResult {
    this.expirePending(now);
    if (this.seenRequestIds.has(requestId)) {
      return { ok: false, code: 'DUPLICATE_REQUEST' };
    }
    if (this.pending !== undefined) {
      return { ok: false, code: 'REQUEST_IN_PROGRESS' };
    }

    const expiresAt = now + APPLY_EDIT_REQUEST_TTL_MS;
    this.seenRequestIds.add(requestId);
    this.pending = { requestId, expiresAt };
    return { ok: true, expiresAt };
  }

  assertActive(requestId: string, now: number): ApplyEditRequestActiveResult {
    if (this.pending?.requestId === requestId && now >= this.pending.expiresAt) {
      this.pending = undefined;
      return { ok: false, code: 'REQUEST_EXPIRED' };
    }
    if (this.pending?.requestId !== requestId) {
      return { ok: false, code: 'REQUEST_NOT_ACTIVE' };
    }
    return { ok: true };
  }

  finish(requestId: string): boolean {
    if (this.pending?.requestId !== requestId) return false;
    this.pending = undefined;
    return true;
  }

  private expirePending(now: number): void {
    if (this.pending !== undefined && now >= this.pending.expiresAt) {
      this.pending = undefined;
    }
  }
}
