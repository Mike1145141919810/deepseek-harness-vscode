/** Host half of the dsh-vscode-bridge plugin. */
import { createEditorContextCommand } from "./editor-context.js";
import { createApplyEditTool } from "./apply-edit.js";

export const inject = ["commands", "tools"];

/** Register the Phase 2B command and proposal-only Phase 2D tool. */
export function apply(ctx) {
  ctx.commands.register(createEditorContextCommand());
  ctx.tools.register(createApplyEditTool());
}
