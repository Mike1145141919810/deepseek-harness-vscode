/** Host half of the dsh-vscode-bridge plugin. */
import { createEditorContextCommand } from "./editor-context.js";

export const inject = ["commands"];

/** Register the non-waking Phase 2B editor-context injection command. */
export function apply(ctx) {
  ctx.commands.register(createEditorContextCommand());
}
