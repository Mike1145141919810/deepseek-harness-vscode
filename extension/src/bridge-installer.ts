import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BRIDGE_PACKAGE_NAME,
  BridgeInstallationStatus,
  detectBridgeInstallation,
  hasBridgeLoaderEntry,
  resolveDshWebProfileDir,
} from './bridge-installation';
import type { ResolvedCommand } from './server-manager';

const OUTPUT_TAIL_LIMIT = 12_000;
const LOADER_ENTRY = `- insert:\n    - id: ${BRIDGE_PACKAGE_NAME}\n      name: '${BRIDGE_PACKAGE_NAME}'`;

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

export interface ProcessInvocation {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export type ResolvedCommandRunner = (
  resolved: ResolvedCommand,
  trailingArgs: string[],
) => Promise<CommandOutput>;

export interface InstallBundledBridgeOptions {
  bundledBridgeDir: string;
  resolvedCommand: ResolvedCommand;
  profileDir?: string;
  run?: ResolvedCommandRunner;
}

export interface InstallBundledBridgeResult {
  status: BridgeInstallationStatus;
  output: CommandOutput;
  patchChanged: boolean;
  patchBackupPath?: string;
}

export interface LoaderPatchResult {
  changed: boolean;
  backupPath?: string;
}

/** Build the exact process invocation while avoiding `shell: true`. */
export function buildProcessInvocation(
  resolved: ResolvedCommand,
  trailingArgs: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec ?? 'cmd.exe',
): ProcessInvocation {
  const args = [...resolved.args, ...trailingArgs];
  const env = resolved.electronAsNode
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : undefined;
  if (!resolved.shell || platform !== 'win32') {
    return { command: stripWrappingQuotes(resolved.command), args, env };
  }
  const commandLine = [stripWrappingQuotes(resolved.command), ...args]
    .map(quoteCmdArg)
    .join(' ');
  return { command: comspec, args: ['/d', '/s', '/c', commandLine], env };
}

/** Run DSH and retain bounded output for the output channel/error message. */
export function runResolvedCommand(
  resolved: ResolvedCommand,
  trailingArgs: string[],
): Promise<CommandOutput> {
  const invocation = buildProcessInvocation(resolved, trailingArgs);
  return new Promise((resolve, reject) => {
    const child = cp.spawn(invocation.command, invocation.args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(invocation.env ? { env: invocation.env } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk.toString('utf8'));
    });
    child.once('error', (error) => reject(new Error(`could not start dsh plugin installer: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = stderr.trim() || stdout.trim();
      reject(
        new Error(
          `dsh plugin installer failed (code=${String(code)} signal=${String(signal)})${
            detail === '' ? '' : `: ${detail}`
          }`,
        ),
      );
    });
  });
}

/**
 * Add the bridge loader row to a DSH patch list. Existing rows are preserved,
 * the default `[]` form is replaced, and repeated calls are idempotent.
 */
export function addBridgeLoaderEntry(patchText: string): string {
  if (hasBridgeLoaderEntry(patchText)) return patchText;
  const eol = patchText.includes('\r\n') ? '\r\n' : '\n';
  const lines = patchText.split(/\r?\n/);
  const active = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim() !== '' && !/^\s*#/.test(line));

  if (active.length === 1 && /^\s*\[\]\s*$/.test(active[0].line)) {
    lines.splice(active[0].index, 1, ...LOADER_ENTRY.split('\n'));
    return lines.join(eol);
  }
  if (active.length > 0 && !/^\s*-/.test(active[0].line)) {
    throw new Error('cordis.patch.yml is not a top-level YAML patch list; refusing to modify it');
  }
  const separator = patchText === '' || patchText.endsWith('\n') || patchText.endsWith('\r') ? '' : eol;
  return `${patchText}${separator}${LOADER_ENTRY}${eol}`;
}

/** Write the loader entry recoverably, retaining the previous file as a backup. */
export function writeBridgeLoaderEntry(profileDir: string): LoaderPatchResult {
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const existed = fs.existsSync(patchPath);
  const original = existed ? fs.readFileSync(patchPath, 'utf8') : '';
  const updated = addBridgeLoaderEntry(original);
  if (updated === original) return { changed: false };

  fs.mkdirSync(profileDir, { recursive: true });
  const tempPath = nextAvailablePath(`${patchPath}.dsh-vscode-${process.pid}.tmp`);
  let backupPath: string | undefined;
  fs.writeFileSync(tempPath, updated, { encoding: 'utf8', flag: 'wx' });
  try {
    if (existed) {
      backupPath = nextAvailablePath(`${patchPath}.dsh-vscode.bak`);
      fs.renameSync(patchPath, backupPath);
    }
    try {
      fs.renameSync(tempPath, patchPath);
    } catch (error) {
      if (backupPath !== undefined && !fs.existsSync(patchPath)) fs.renameSync(backupPath, patchPath);
      throw error;
    }
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
  return { changed: true, backupPath };
}

/** Install/update the packaged bridge, then enable and verify its loader row. */
export async function installBundledBridge(
  options: InstallBundledBridgeOptions,
): Promise<InstallBundledBridgeResult> {
  const bundledBridgeDir = validateBundledBridgeDir(options.bundledBridgeDir);
  const profileDir = options.profileDir ?? resolveDshWebProfileDir();
  const pluginArgs = ['plugin', '--profile', 'web', 'add', '-w', toDshPath(bundledBridgeDir)];
  const output = await (options.run ?? runResolvedCommand)(options.resolvedCommand, pluginArgs);

  const dependencyStatus = detectBridgeInstallation(profileDir);
  if (!dependencyStatus.dependencyDeclared || !dependencyStatus.modulePresent) {
    throw new Error(
      `dsh plugin installer exited successfully, but ${BRIDGE_PACKAGE_NAME} was not materialized in ${profileDir}`,
    );
  }

  const patch = writeBridgeLoaderEntry(profileDir);
  const status = detectBridgeInstallation(profileDir);
  if (status.state !== 'installed') {
    throw new Error(`bridge installation verification failed: ${status.state}`);
  }
  return {
    status,
    output,
    patchChanged: patch.changed,
    patchBackupPath: patch.backupPath,
  };
}

function validateBundledBridgeDir(input: string): string {
  const directory = path.resolve(input);
  const manifestPath = path.join(directory, 'package.json');
  let manifest: { name?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown };
  } catch (error) {
    throw new Error(`bundled bridge is unavailable at ${directory}: ${String(error)}`);
  }
  if (manifest.name !== BRIDGE_PACKAGE_NAME) {
    throw new Error(`bundled bridge manifest at ${manifestPath} has an unexpected package name`);
  }
  return directory;
}

function toDshPath(input: string): string {
  return process.platform === 'win32' ? input.replace(/\\/g, '/') : input;
}

function stripWrappingQuotes(input: string): string {
  return input.replace(/^"(.*)"$/, '$1');
}

function quoteCmdArg(input: string): string {
  if (input !== '' && !/[\s&|<>^]/.test(input)) return input;
  return `"${input.replace(/"/g, '^"')}"`;
}

function appendTail(current: string, addition: string): string {
  return `${current}${addition}`.slice(-OUTPUT_TAIL_LIMIT);
}

function nextAvailablePath(preferred: string): string {
  if (!fs.existsSync(preferred)) return preferred;
  for (let index = 1; ; index++) {
    const candidate = `${preferred}.${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}
