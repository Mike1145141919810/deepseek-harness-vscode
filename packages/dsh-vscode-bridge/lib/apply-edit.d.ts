export interface ApplyEditToolArgs {
  file_path: string;
  before_text: string;
  after_text: string;
}

export interface ApplyEditProposal {
  version: 1;
  requestId: string;
  file: string;
  beforeSha256: string;
  beforeText: string;
  afterText: string;
}

export declare const APPLY_EDIT_TOOL_NAME = "vscode_apply_diff";
export declare const APPLY_EDIT_TOOL_VERSION = 1;
export declare const MAX_APPLY_EDIT_TOOL_FILE_CHARS = 32768;
export declare const MAX_APPLY_EDIT_TOOL_TEXT_CHARS = 1048576;
export declare function parseApplyEditToolArgs(value: unknown):
  | { ok: true; value: ApplyEditToolArgs }
  | { ok: false; reason: string };
export declare function createApplyEditTool(options?: {
  createRequestId?: () => string;
}): {
  name: typeof APPLY_EDIT_TOOL_NAME;
  execute(args: unknown): Promise<ApplyEditProposal>;
  [key: string]: unknown;
};
