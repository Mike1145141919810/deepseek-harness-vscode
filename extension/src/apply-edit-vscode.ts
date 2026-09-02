/** VS Code execution layer for one confirmed Phase 2D full-file replacement. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ApplyEditRequestGate,
  ApplyEditRequestMessage,
  ApplyEditSafetyErrorCode,
  validateApplyEditPrecondition,
  validateWorkspacePath,
  WorkspacePathIdentity,
} from './apply-edit';

const APPLY_ACTION = 'Apply edit';

interface DiffDocumentOpener {
  openDocuments(
    file: string,
    originalText: string,
    modifiedText: string,
    title?: string,
  ): Promise<void>;
}

export interface ApplyEditConfirmation {
  relativePath: string;
  sessionId: string;
  beforeChars: number;
  afterChars: number;
}

export type ApplyEditConfirmationHandler = (
  confirmation: ApplyEditConfirmation,
) => Promise<boolean>;

export interface ApplyEditControllerOptions {
  confirm?: ApplyEditConfirmationHandler;
  now?: () => number;
  isWorkspaceTrusted?: () => boolean;
}

export type ApplyEditExecutionResult =
  | {
      ok: true;
      requestId: string;
      sessionId: string;
      documentVersion: number;
    }
  | {
      ok: false;
      requestId: string;
      sessionId: string;
      error: { code: ApplyEditSafetyErrorCode; message: string };
    };

type FileValidationResult =
  | {
      ok: true;
      document: vscode.TextDocument;
      workspaceFolder: WorkspacePathIdentity;
    }
  | { ok: false; code: ApplyEditSafetyErrorCode; message: string };

/**
 * Owns the native preview/confirmation/apply flow. It is intentionally not
 * connected to a webview or DSH command in this slice.
 */
export class ApplyEditController {
  private readonly gate = new ApplyEditRequestGate();
  private readonly confirm: ApplyEditConfirmationHandler;
  private readonly now: () => number;
  private readonly isWorkspaceTrusted: () => boolean;

  constructor(
    private readonly preview: DiffDocumentOpener,
    options: ApplyEditControllerOptions = {},
  ) {
    this.confirm = options.confirm ?? showNativeConfirmation;
    this.now = options.now ?? Date.now;
    this.isWorkspaceTrusted = options.isWorkspaceTrusted ?? (() => vscode.workspace.isTrusted);
  }

  async apply(request: ApplyEditRequestMessage): Promise<ApplyEditExecutionResult> {
    const started = this.gate.begin(request.requestId, this.now());
    if (!started.ok) return failure(request, started.code, requestGateMessage(started.code));

    try {
      const initial = await this.validateFile(request);
      if (!initial.ok) return failure(request, initial.code, initial.message);
      const initialVersion = initial.document.version;

      await this.preview.openDocuments(
        request.file,
        request.beforeText,
        request.afterText,
        `DSH proposed edit: ${path.basename(request.file) || 'change'}`,
      );

      const relativePath = path.relative(initial.workspaceFolder.folderPath, request.file);
      const confirmed = await this.confirm({
        relativePath,
        sessionId: request.sessionId,
        beforeChars: request.beforeText.length,
        afterChars: request.afterText.length,
      });
      if (!confirmed) {
        return failure(request, 'USER_CANCELLED', 'The edit was cancelled; no file was changed.');
      }

      const active = this.gate.assertActive(request.requestId, this.now());
      if (!active.ok) return failure(request, active.code, requestGateMessage(active.code));

      // Re-run trust, filesystem identity, dirty/preimage, and document-version
      // checks after confirmation to close the preview/confirmation TOCTOU gap.
      const final = await this.validateFile(request, initialVersion);
      if (!final.ok) return failure(request, final.code, final.message);

      const editor = await vscode.window.showTextDocument(final.document, {
        preview: false,
        preserveFocus: false,
      });
      const immediatelyBeforeApply = await this.validateFile(request, initialVersion);
      if (!immediatelyBeforeApply.ok) {
        return failure(request, immediatelyBeforeApply.code, immediatelyBeforeApply.message);
      }
      if (editor.document.uri.toString() !== immediatelyBeforeApply.document.uri.toString()) {
        return failure(request, 'APPLY_FAILED', 'VS Code changed the target editor before apply.');
      }
      const stillActive = this.gate.assertActive(request.requestId, this.now());
      if (!stillActive.ok) {
        return failure(request, stillActive.code, requestGateMessage(stillActive.code));
      }
      const fullRange = new vscode.Range(
        immediatelyBeforeApply.document.positionAt(0),
        immediatelyBeforeApply.document.positionAt(immediatelyBeforeApply.document.getText().length),
      );
      const applied = await editor.edit(
        (edit) => edit.replace(fullRange, request.afterText),
        { undoStopBefore: true, undoStopAfter: true },
      );
      if (!applied || immediatelyBeforeApply.document.getText() !== request.afterText) {
        return failure(request, 'APPLY_FAILED', 'VS Code did not apply the complete edit.');
      }

      return {
        ok: true,
        requestId: request.requestId,
        sessionId: request.sessionId,
        documentVersion: immediatelyBeforeApply.document.version,
      };
    } catch (error) {
      return failure(
        request,
        'APPLY_FAILED',
        'VS Code could not apply the edit.',
      );
    } finally {
      this.gate.finish(request.requestId);
    }
  }

  private async validateFile(
    request: ApplyEditRequestMessage,
    expectedVersion?: number,
  ): Promise<FileValidationResult> {
    if (!this.isWorkspaceTrusted()) {
      return {
        ok: false,
        code: 'WORKSPACE_UNTRUSTED',
        message: 'DSH edits require a trusted VS Code workspace.',
      };
    }

    const localFolders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === 'file',
    );
    if (localFolders.length === 0) {
      return {
        ok: false,
        code: 'OUTSIDE_WORKSPACE',
        message: 'The target is not inside an open local workspace folder.',
      };
    }

    let targetRealPath: string;
    try {
      const stat = await fs.stat(request.file);
      if (!stat.isFile()) {
        return {
          ok: false,
          code: 'UNSUPPORTED_FILE',
          message: 'The target must be an existing regular file.',
        };
      }
      targetRealPath = await fs.realpath(request.file);
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return { ok: false, code: 'FILE_NOT_FOUND', message: 'The target file does not exist.' };
      }
      return {
        ok: false,
        code: 'UNSUPPORTED_FILE',
        message: 'The target file cannot be inspected as a regular local file.',
      };
    }

    const workspaceIdentities: WorkspacePathIdentity[] = [];
    for (const folder of localFolders) {
      try {
        workspaceIdentities.push({
          folderPath: folder.uri.fsPath,
          folderRealPath: await fs.realpath(folder.uri.fsPath),
        });
      } catch (error) {
        return {
          ok: false,
          code: 'APPLY_FAILED',
          message: 'A workspace path cannot be inspected safely.',
        };
      }
    }

    const pathResult = validateWorkspacePath(
      request.file,
      targetRealPath,
      workspaceIdentities,
    );
    if (!pathResult.ok) {
      return {
        ok: false,
        code: pathResult.code,
        message: pathResult.code === 'SYMLINK_ESCAPE'
          ? 'The target resolves outside its workspace folder.'
          : 'The target is not inside an open local workspace folder.',
      };
    }

    let document: vscode.TextDocument;
    try {
      document = await findOrOpenTargetDocument(request.file, targetRealPath);
    } catch (error) {
      return {
        ok: false,
        code: 'UNSUPPORTED_FILE',
        message: 'VS Code cannot open the target as a local text document.',
      };
    }
    if (document.uri.scheme !== 'file' || document.isUntitled) {
      return {
        ok: false,
        code: 'UNSUPPORTED_FILE',
        message: 'Only existing local text files are supported.',
      };
    }

    const precondition = validateApplyEditPrecondition(
      request,
      {
        text: document.getText(),
        version: document.version,
        isDirty: document.isDirty,
      },
      expectedVersion,
    );
    if (!precondition.ok) {
      return {
        ok: false,
        code: precondition.code,
        message: precondition.code === 'DIRTY_DOCUMENT'
          ? 'The target has unsaved changes; the DSH edit was not applied.'
          : 'The target changed after the proposal was created; the DSH edit was not applied.',
      };
    }

    return { ok: true, document, workspaceFolder: pathResult.workspaceFolder };
  }
}

async function showNativeConfirmation(confirmation: ApplyEditConfirmation): Promise<boolean> {
  const session = confirmation.sessionId.length <= 80
    ? confirmation.sessionId
    : `${confirmation.sessionId.slice(0, 77)}...`;
  const action = await vscode.window.showWarningMessage(
    `Apply the DSH edit to ${confirmation.relativePath}?`,
    {
      modal: true,
      detail: `Session: ${session}\nFull-file replacement: ${confirmation.beforeChars} → ${confirmation.afterChars} UTF-16 characters. The document will remain unsaved so you can review or undo it.`,
    },
    APPLY_ACTION,
  );
  return action === APPLY_ACTION;
}

function failure(
  request: ApplyEditRequestMessage,
  code: ApplyEditSafetyErrorCode,
  message: string,
): ApplyEditExecutionResult {
  return {
    ok: false,
    requestId: request.requestId,
    sessionId: request.sessionId,
    error: { code, message },
  };
}

function requestGateMessage(code: ApplyEditSafetyErrorCode): string {
  switch (code) {
    case 'DUPLICATE_REQUEST':
      return 'This edit request was already handled.';
    case 'REQUEST_IN_PROGRESS':
      return 'Another edit request is awaiting confirmation.';
    case 'REQUEST_EXPIRED':
      return 'The edit request expired before it could be applied.';
    case 'REQUEST_NOT_ACTIVE':
      return 'The edit request is no longer active.';
    default:
      return 'The edit request failed its safety gate.';
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

/**
 * Reuse an already-open alias of the same real file so Windows 8.3 paths,
 * symlinks, or case differences cannot hide an unsaved document. Opening the
 * canonical 8.3 path directly would make VS Code create a second buffer.
 */
async function findOrOpenTargetDocument(
  presentedPath: string,
  targetRealPath: string,
): Promise<vscode.TextDocument> {
  const matches: vscode.TextDocument[] = [];
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== 'file' || document.isUntitled) continue;
    try {
      const documentRealPath = await fs.realpath(document.uri.fsPath);
      if (sameCanonicalPath(documentRealPath, targetRealPath)) matches.push(document);
    } catch {
      // A stale/deleted open document cannot be the validated existing target.
    }
  }
  if (matches.length > 1) {
    throw new Error('Multiple VS Code documents refer to the same real file.');
  }
  return matches[0] ?? vscode.workspace.openTextDocument(vscode.Uri.file(presentedPath));
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
