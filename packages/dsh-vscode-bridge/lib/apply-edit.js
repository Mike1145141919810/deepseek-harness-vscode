/** Proposal-only DSH Host tool for Phase 2D. It never reads or writes files. */
import { createHash, randomUUID } from "node:crypto";

export const APPLY_EDIT_TOOL_NAME = "vscode_apply_diff";
export const APPLY_EDIT_TOOL_VERSION = 1;
export const MAX_APPLY_EDIT_TOOL_FILE_CHARS = 32_768;
export const MAX_APPLY_EDIT_TOOL_TEXT_CHARS = 1_048_576;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
}

/** Strictly validate model arguments without echoing rejected content. */
export function parseApplyEditToolArgs(value) {
  if (!isRecord(value)) return { ok: false, reason: "arguments must be an object" };
  if (!exactKeys(value, ["file_path", "before_text", "after_text"])) {
    return { ok: false, reason: "arguments must contain only file_path, before_text, and after_text" };
  }
  if (
    typeof value.file_path !== "string" ||
    value.file_path.length === 0 ||
    value.file_path.trim() !== value.file_path
  ) return { ok: false, reason: "file_path must be a non-empty trimmed string" };
  if (value.file_path.length > MAX_APPLY_EDIT_TOOL_FILE_CHARS) {
    return { ok: false, reason: "file_path is too long" };
  }
  if (/[\u0000-\u001f\u007f]/u.test(value.file_path)) {
    return { ok: false, reason: "file_path contains a forbidden control character" };
  }
  if (typeof value.before_text !== "string" || typeof value.after_text !== "string") {
    return { ok: false, reason: "before_text and after_text must be strings" };
  }
  if (
    value.before_text.length > MAX_APPLY_EDIT_TOOL_TEXT_CHARS ||
    value.after_text.length > MAX_APPLY_EDIT_TOOL_TEXT_CHARS
  ) return { ok: false, reason: "file text is too large" };
  if (value.before_text.includes("\0") || value.after_text.includes("\0")) {
    return { ok: false, reason: "file text contains a forbidden NUL character" };
  }
  if (value.before_text === value.after_text) {
    return { ok: false, reason: "the proposal must change the file text" };
  }
  return {
    ok: true,
    value: {
      file_path: value.file_path,
      before_text: value.before_text,
      after_text: value.after_text,
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function proposalFromMeta(value) {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "requestId", "file", "beforeSha256", "beforeText", "afterText",
  ])) return undefined;
  if (
    value.version !== APPLY_EDIT_TOOL_VERSION ||
    typeof value.requestId !== "string" ||
    typeof value.file !== "string" ||
    typeof value.beforeSha256 !== "string" ||
    typeof value.beforeText !== "string" ||
    typeof value.afterText !== "string"
  ) return undefined;
  return {
    version: value.version,
    requestId: value.requestId,
    file: value.file,
    beforeSha256: value.beforeSha256,
    beforeText: value.beforeText,
    afterText: value.afterText,
  };
}

/**
 * Construct a registry-ready tool without importing @deepseek-ai/dsh-tools.
 * Linked profile plugins resolve from this package directory, so keeping this
 * definition dependency-free preserves the verified installation layout.
 */
export function createApplyEditTool(options = {}) {
  const createRequestId = options.createRequestId ?? randomUUID;
  const definition = {
    name: APPLY_EDIT_TOOL_NAME,
    description:
      "Propose replacing one existing text file through VS Code. This tool does not modify files. Supply the exact complete current file as before_text and the exact complete desired file as after_text. VS Code will independently verify the preimage and require native user confirmation before applying an unsaved, undoable edit.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description: "Workspace-relative or absolute path to one existing text file.",
        },
        before_text: {
          type: "string",
          description: "Exact complete current UTF-8 text of the file.",
        },
        after_text: {
          type: "string",
          description: "Exact complete desired UTF-8 text of the file.",
        },
      },
      required: ["file_path", "before_text", "after_text"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer" },
          requestId: { type: "string" },
          file: { type: "string" },
          beforeSha256: { type: "string" },
          beforeText: { type: "string" },
          afterText: { type: "string" },
        },
        required: ["version", "requestId", "file", "beforeSha256", "beforeText", "afterText"],
      },
      render: (_args, value) => [{
        type: "text",
        text: `Edit proposal ${value.requestId} is ready for explicit review in VS Code. No file was modified.`,
      }],
      presentationMeta: (_args, value) => value,
    },
    async execute(args) {
      const parsed = parseApplyEditToolArgs(args);
      if (!parsed.ok) throw new TypeError(`Invalid ${APPLY_EDIT_TOOL_NAME} arguments: ${parsed.reason}`);
      const requestId = createRequestId();
      if (
        typeof requestId !== "string" ||
        requestId.length === 0 ||
        requestId.length > 128 ||
        requestId.trim() !== requestId ||
        /[\u0000-\u001f\u007f]/u.test(requestId)
      ) throw new Error(`${APPLY_EDIT_TOOL_NAME} request ID generation failed`);
      return {
        version: APPLY_EDIT_TOOL_VERSION,
        requestId,
        file: parsed.value.file_path,
        beforeSha256: sha256(parsed.value.before_text),
        beforeText: parsed.value.before_text,
        afterText: parsed.value.after_text,
      };
    },
    isConcurrencySafe: (args) => parseApplyEditToolArgs(args).ok,
    presentCall(args) {
      const parsed = parseApplyEditToolArgs(args);
      if (!parsed.ok) return undefined;
      return {
        card: "generic",
        title: `Propose VS Code edit: ${parsed.value.file_path}`,
        kind: "edit",
        locations: [{ path: parsed.value.file_path }],
      };
    },
    presentResult(args, result) {
      if (result.isError) return undefined;
      const parsed = parseApplyEditToolArgs(args);
      const proposal = proposalFromMeta(result.meta);
      if (!parsed.ok || proposal === undefined) return undefined;
      return {
        card: "generic",
        title: `VS Code edit proposed: ${parsed.value.file_path}`,
        kind: "edit",
        locations: [{ path: parsed.value.file_path }],
        dshVscodeApplyProposal: proposal,
      };
    },
  };
  return definition;
}
