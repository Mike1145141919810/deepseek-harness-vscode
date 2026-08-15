/** Safety-boundary validation, kept free of any `vscode` import for unit tests. */

/** CLI flags the user may never override: they define the security boundary. */
export const FORBIDDEN_EXTRA_ARGS = ['--host', '--port', '--trusted-host'];

/**
 * Return the extraArgs entries that would override the safety boundary.
 * Matches `--host`, `--port`, `--trusted-host` in both `--flag value` and
 * `--flag=value` shapes.
 */
export function forbiddenExtraArgs(args: string[]): string[] {
  const problems: string[] = [];
  for (const arg of args) {
    const name = arg.split('=')[0].trim();
    if (FORBIDDEN_EXTRA_ARGS.includes(name)) problems.push(arg);
  }
  return problems;
}
