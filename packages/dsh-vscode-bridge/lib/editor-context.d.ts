export declare const EDITOR_CONTEXT_VERSION: 1;
export declare const MAX_EDITOR_SELECTION_CHARS: 16384;
export declare const MAX_EDITOR_CONTEXT_COMMAND_CHARS: 131072;

export interface EditorContextPosition {
  readonly line: number;
  readonly character: number;
}

export interface EditorContextSnapshot {
  readonly version: 1;
  readonly file: string;
  readonly uri: string;
  readonly languageId: string;
  readonly documentVersion: number;
  readonly isDirty: boolean;
  readonly cursor: EditorContextPosition;
  readonly selection?: {
    readonly start: EditorContextPosition;
    readonly end: EditorContextPosition;
    readonly text: string;
    readonly truncated: boolean;
  };
}

export type EditorContextParseResult =
  | { readonly ok: true; readonly value: EditorContextSnapshot }
  | { readonly ok: false; readonly reason: string };

export declare function parseEditorContextCommandInput(rawInput: string): EditorContextParseResult;
export declare function formatEditorContextForModel(context: EditorContextSnapshot): string;
export declare function createBridgeUserMessage(input: unknown): Readonly<{
  readonly role: "user";
  readonly id: string;
}> & object;

export interface EditorContextCommandInvocation {
  readonly rawInput: string;
  readonly agent: { inject(message: unknown): void };
}

export interface EditorContextCommand {
  readonly name: "vscode-context";
  readonly description: string;
  readonly input: { readonly hint: string };
  readonly recordInput: false;
  readonly handler: (invocation: EditorContextCommandInvocation) =>
    | { readonly kind: "success"; readonly text: string }
    | { readonly kind: "error"; readonly text: string };
}

export declare function createEditorContextCommand(
  createUserMessage?: (input: unknown) => unknown,
): EditorContextCommand;
