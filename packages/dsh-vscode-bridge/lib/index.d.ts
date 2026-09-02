import type { EditorContextCommand } from './editor-context.js';
import type { createApplyEditTool } from './apply-edit.js';

export declare const inject: readonly ['commands', 'tools'];
export declare function apply(ctx: {
  commands: { register(command: EditorContextCommand): unknown };
  tools: { register(tool: ReturnType<typeof createApplyEditTool>): unknown };
}): void;
