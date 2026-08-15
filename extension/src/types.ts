/** Shared types with no `vscode` dependency (unit-testable). */

export interface DshSettings {
  /** Path to dsh's bin.js or a folder containing it. Empty = auto-detect on PATH. */
  binPath: string;
  /** Where the GUI opens. */
  openIn: 'panel' | 'browser';
  /** Whether npx bootstrap is allowed when no local dsh is found. */
  allowNpxFallback: boolean;
  /** Start the server when VS Code starts. */
  autoStart: boolean;
  /** Seed the VS Code workspace folders as DSH workspaces on open. */
  autoWorkspace: boolean;
  /** Extra CLI args. Safety-relevant flags are rejected by the extension. */
  extraArgs: string[];
  /** Version used by the npx fallback. */
  pinnedVersion: string;
}

export interface LoggerLike {
  log(message: string): void;
}
