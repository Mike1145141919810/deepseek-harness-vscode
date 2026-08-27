/** Shared VS Code host handler for messages from panel and sidebar webviews. */
import * as vscode from 'vscode';
import {
  createEditorContextErrorResponse,
  createEditorContextSuccessResponse,
  EDITOR_CONTEXT_REQUEST_MESSAGE_TYPE,
  parseEditorContextRequestMessage,
} from './editor-context-bridge';
import { EditorContextTracker } from './editor-context-vscode';
import { openInEditorFromMessage } from './editor-bridge-vscode';
import { LoggerLike } from './types';

interface WebviewMessagePort {
  postMessage(message: unknown): Thenable<boolean>;
}

function messageType(message: unknown): unknown {
  return typeof message === 'object' && message !== null
    ? (message as Record<string, unknown>).type
    : undefined;
}

async function postEditorContextResponse(
  message: unknown,
  webview: WebviewMessagePort,
  editorContext: EditorContextTracker,
  logger: LoggerLike,
): Promise<void> {
  const parsed = parseEditorContextRequestMessage(message);
  if (!parsed.ok) {
    logger.log(`editor context request rejected: ${parsed.reason}`);
    return;
  }

  let response;
  try {
    const context = editorContext.getSnapshot();
    response = context === undefined
      ? createEditorContextErrorResponse(
          parsed.value,
          'NO_EDITOR_CONTEXT',
          'No open local file editor is available.',
        )
      : createEditorContextSuccessResponse(parsed.value, context);
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error);
    logger.log(`editor context read failed: ${detail}`);
    response = createEditorContextErrorResponse(
      parsed.value,
      'EDITOR_CONTEXT_READ_FAILED',
      'VS Code could not read the editor context.',
    );
  }

  try {
    const delivered = await webview.postMessage(response);
    logger.log(
      delivered
        ? `editor context response sent (request=${parsed.value.requestId})`
        : `editor context response not delivered (request=${parsed.value.requestId})`,
    );
  } catch (error) {
    logger.log(`editor context response failed: ${String(error instanceof Error ? error.message : error)}`);
  }
}

/**
 * Handle bridge messages shared by GuiPanel and SidebarView. Returns true when
 * the message belongs to the bridge, including rejected context requests.
 */
export function handleDshWebviewMessage(
  message: unknown,
  webview: WebviewMessagePort,
  editorContext: EditorContextTracker,
  logger: LoggerLike,
): boolean {
  const type = messageType(message);
  if (type === 'dsh.openInEditor') {
    const file = (message as { file?: unknown }).file;
    logger.log(`open in editor requested${typeof file === 'string' ? `: ${file}` : ''}`);
    void openInEditorFromMessage(message)
      .then(() => {
        if (typeof file === 'string') logger.log(`opened in editor: ${file}`);
      })
      .catch((error) => {
        const detail = String(error instanceof Error ? error.message : error);
        logger.log(`open in editor failed: ${detail}`);
        void vscode.window.showWarningMessage(`DeepSeek Harness: ${detail}`);
      });
    return true;
  }
  if (type === EDITOR_CONTEXT_REQUEST_MESSAGE_TYPE) {
    void postEditorContextResponse(message, webview, editorContext, logger);
    return true;
  }
  return false;
}
