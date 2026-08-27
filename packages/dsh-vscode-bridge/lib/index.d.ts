import type { EditorContextCommand } from './editor-context.js';

export declare const inject: readonly ['commands'];
export declare function apply(ctx: {
  commands: { register(command: EditorContextCommand): unknown };
}): void;
