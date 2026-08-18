/**
 * Host half of the dsh-vscode-bridge plugin.
 *
 * Phase 2A needs no host-side service yet: the browser half renders buttons
 * and posts `dsh:openInEditor` messages to the VS Code extension's webview
 * parent. This file exists so `dsh plugin --profile web add file:...` has a
 * valid Cordis plugin entry point.
 */
export const inject = [];

export function apply() {
  // Intentionally empty. The client half (exports["./client"]) does the work.
}
