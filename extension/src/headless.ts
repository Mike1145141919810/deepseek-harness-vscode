/**
 * Builds a terminal invocation for `dsh --profile headless "<task>"`.
 *
 * Pure module (no `vscode` import) so quoting/argv choices are unit-testable.
 * node-bin invocations run node + bin.js directly via argv array (no shell
 * quoting needed); cmd/npx/path variants go through cmd.exe or /bin/sh.
 */
import { ResolvedCommand } from './server-manager';
import { DshSettings } from './types';

export interface HeadlessInvocation {
  shellPath: string;
  shellArgs: string[];
}

function quoteCmdArg(value: string): string {
  const needsQuote = /\s/.test(value) || value === '' || /[&|<>^]/.test(value);
  if (!needsQuote) return value;
  // cmd.exe: wrap in double quotes; embedded quotes are best-effort escaped.
  return `"${value.replace(/"/g, '^"')}"`;
}

function buildCmdLine(command: string, args: string[]): string {
  return [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(' ');
}

function quoteShArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildHeadlessInvocation(
  resolved: ResolvedCommand,
  settings: DshSettings,
  task: string,
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec ?? 'cmd.exe',
): HeadlessInvocation {
  const args = ['--profile', 'headless', task];

  if (resolved.kind === 'node-bin') {
    // Real node + bin.js: argv array avoids shell quoting entirely.
    return { shellPath: resolved.command, shellArgs: [...resolved.args, ...args] };
  }

  if (resolved.kind === 'npx') {
    const npxArgs = [...resolved.args, ...args];
    if (platform === 'win32') {
      return { shellPath: comspec, shellArgs: ['/d', '/s', '/c', buildCmdLine(resolved.command, npxArgs)] };
    }
    return { shellPath: resolved.command, shellArgs: npxArgs };
  }

  // kind === 'path' (e.g. a user-supplied dsh.cmd outside node_modules/.bin)
  if (platform === 'win32') {
    return { shellPath: comspec, shellArgs: ['/d', '/s', '/c', buildCmdLine(resolved.command, args)] };
  }
  return {
    shellPath: '/bin/sh',
    shellArgs: ['-c', `${quoteShArg(resolved.command)} --profile headless ${JSON.stringify(task)}`],
  };
}
