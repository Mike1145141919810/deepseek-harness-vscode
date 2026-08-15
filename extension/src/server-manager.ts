/**
 * Spawns and supervises the `dsh web` server.
 *
 * Security boundary: the extension always passes `--host 127.0.0.1` and an
 * extension-allocated `--port N`; user `extraArgs` are validated upstream and
 * can never override these flags (see settings.ts).
 *
 * Startup protocol: the extension pre-allocates a free port, spawns dsh, and
 * health-probes `http://127.0.0.1:N/` — the stdout startup line is parsed only
 * for diagnostics (stdout-adapter.ts).
 */
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { parsePortFromStream } from './stdout-adapter';
import { forbiddenExtraArgs } from './security';
import { DshSettings, LoggerLike } from './types';

export type ServerState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'stopping'
  | 'stopped';

export interface ServerInstance {
  instanceId: string;
  pid: number | undefined;
  port: number;
  startedAt: string;
}

export interface ResolvedCommand {
  kind: 'node-bin' | 'path' | 'npx';
  command: string;
  args: string[];
  /** True when the spawn needs a shell (cmd/bat/ps1 shims on Windows). */
  shell: boolean;
  /** True when Electron itself runs bin.js and needs ELECTRON_RUN_AS_NODE=1. */
  electronAsNode?: boolean;
}

const HOST = '127.0.0.1';
const START_TIMEOUT_MS = 60000;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const SHUTDOWN_GRACE_MS = 3000;
const PORT_RETRIES = 3;

export class DshError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'DSH_NOT_FOUND'
      | 'NPX_NETWORK_FAILED'
      | 'START_TIMEOUT'
      | 'START_FAILED'
      | 'FORBIDDEN_EXTRA_ARGS'
      | 'PORT_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'DshError';
  }
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Whether this runtime is Electron (VS Code extension host) rather than plain Node. */
export function isElectronRuntime(versions: NodeJS.ProcessVersions = process.versions): boolean {
  return typeof versions.electron === 'string' && versions.electron !== '';
}

/**
 * Resolve the executable that actually runs dsh's bin.js.
 *
 * Inside the VS Code extension host `process.execPath` is Electron (Code.exe),
 * which cannot run bin.js — and dsh's native modules (node-pty) are built
 * against a real Node ABI anyway. Prefer a real `node` from PATH; only when
 * none exists fall back to Electron itself with ELECTRON_RUN_AS_NODE=1.
 */
export function resolveNodeBinary(
  pathEnv: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): { command: string; electronAsNode: boolean } {
  if (!isElectronRuntime()) return { command: process.execPath, electronAsNode: false };
  const found = findOnPathSync('node', platform === 'win32', pathEnv);
  if (found !== undefined) return { command: found, electronAsNode: false };
  return { command: process.execPath, electronAsNode: true };
}

function findOnPathSync(name: string, win: boolean, pathEnv: string): string | undefined {
  const command = win ? 'where' : 'which';
  try {
    const result = cp.execFileSync(command, [name], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PATH: pathEnv },
    });
    const first = result.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
    return first;
  } catch {
    return undefined;
  }
}

/** Locate dsh: 1) settings.binPath, 2) PATH, 3) npx (explicit opt-in). */
export async function discoverCommand(
  settings: DshSettings,
  platform: NodeJS.Platform = process.platform,
  pathEnv: string = process.env.PATH ?? '',
): Promise<ResolvedCommand> {
  const win = platform === 'win32';

  if (settings.binPath.trim() !== '') {
    const configured = settings.binPath.trim();
    const candidates = configured.endsWith('.js')
      ? [configured]
      : [
          path.join(configured, 'lib', 'bin.js'),
          path.join(configured, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        ];
    for (const candidate of candidates) {
      if (exists(candidate)) {
        const node = resolveNodeBinary(pathEnv, platform);
        return { kind: 'node-bin', command: node.command, args: [candidate], shell: false, electronAsNode: node.electronAsNode };
      }
    }
    throw new DshError(
      `dsh.binPath points to "${configured}" but no usable bin.js was found there (tried ${candidates.join(', ')})`,
      'DSH_NOT_FOUND',
    );
  }

  const onPath = await findOnPath('dsh', win, pathEnv);
  if (onPath) {
    const needsShell = win && /\.(cmd|bat|ps1)$/i.test(onPath);
    return { kind: 'path', command: onPath, args: [], shell: needsShell };
  }

  if (settings.allowNpxFallback) {
    return {
      kind: 'npx',
      command: win ? 'npx.cmd' : 'npx',
      args: ['--yes', `@deepseek-ai/dsh@${settings.pinnedVersion}`],
      shell: win,
    };
  }

  throw new DshError(
    'dsh was not found: set dsh.binPath to the dsh lib/bin.js, add dsh to PATH, or enable dsh.allowNpxFallback to bootstrap it via npx (network required)',
    'DSH_NOT_FOUND',
  );
}

async function findOnPath(name: string, win: boolean, pathEnv: string): Promise<string | undefined> {
  const command = win ? 'where' : 'which';
  try {
    const result = cp.execFileSync(command, [name], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PATH: pathEnv },
    });
    const first = result.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    return first;
  } catch {
    return undefined;
  }
}

/** Allocate a free loopback port (small race window; retried by callers). */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

/** Build the final dsh argv: launcher subcommand + fixed safety flags + extras. */
export function buildWebArgs(port: number, extraArgs: string[]): string[] {
  return ['web', '--host', HOST, '--port', String(port), ...extraArgs];
}

/** Probe the server root; resolves true when it answers (any HTTP status). */
export function healthProbe(port: number, timeoutMs = HEALTH_REQUEST_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: HOST, port, path: '/', timeout: timeoutMs, agent: false },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.once('error', () => resolve(false));
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForHealthy(
  port: number,
  timeoutMs: number,
  log?: LoggerLike,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastReport = 0;
  for (;;) {
    if (await healthProbe(port)) return true;
    if (Date.now() >= deadline) return false;
    const elapsed = Date.now() - (deadline - timeoutMs);
    if (log && elapsed - lastReport >= 5000) {
      lastReport = elapsed;
      log.log(`waiting for dsh health on ${HOST}:${port} (${Math.round(elapsed / 1000)}s/${Math.round(timeoutMs / 1000)}s)`);
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
}

export interface ServerManagerOptions {
  settings: () => DshSettings;
  logger: LoggerLike;
  onStateChange?: (state: ServerState, instance?: ServerInstance) => void;
}

export class ServerManager {
  private state: ServerState = 'idle';
  private instance?: ServerInstance;
  private child?: cp.ChildProcess;
  private startPromise?: Promise<string>;
  private disposed = false;
  private restartAttempted = false;
  /** True while WE kill the child (timeout/stop/dispose): suppress auto-restart. */
  private intentionalExit = false;
  private readinessListeners: Array<(url: string) => void> = [];
  private stateListeners: Array<(state: ServerState, instance?: ServerInstance) => void> = [];

  constructor(private readonly options: ServerManagerOptions) {}

  getState(): ServerState {
    return this.state;
  }

  getInstance(): ServerInstance | undefined {
    return this.instance;
  }

  getUrl(): string | undefined {
    return this.instance ? `http://${HOST}:${this.instance.port}` : undefined;
  }

  onReady(listener: (url: string) => void): void {
    this.readinessListeners.push(listener);
  }

  onStateChange(listener: (state: ServerState, instance?: ServerInstance) => void): void {
    this.stateListeners.push(listener);
  }

  /** Start the server if needed; resolves to the ready URL. */
  ensureUrl(): Promise<string> {
    if (this.disposed) return Promise.reject(new DshError('server manager disposed', 'START_FAILED'));
    if (this.state === 'ready' && this.instance) return Promise.resolve(this.getUrl()!);
    if (this.state === 'starting' && this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    return this.startPromise;
  }

  async start(): Promise<string> {
    const settings = this.options.settings();
    const problems = forbiddenExtraArgs(settings.extraArgs);
    if (problems.length > 0) {
      this.setState('failed');
      throw new DshError(
        `dsh.extraArgs contains safety-relevant flag(s) that are not allowed: ${problems.join(', ')}`,
        'FORBIDDEN_EXTRA_ARGS',
      );
    }

    let command: ResolvedCommand;
    try {
      command = await discoverCommand(settings);
    } catch (error) {
      this.setState('failed');
      if (error instanceof DshError) throw error;
      throw new DshError(`failed to locate dsh: ${String(error)}`, 'DSH_NOT_FOUND');
    }

    const port = await this.allocatePort();
    const args = [...command.args, ...buildWebArgs(port, settings.extraArgs)];
    this.options.logger.log(
      `starting dsh (kind=${command.kind}): ${command.command} ${args.map((a) => JSON.stringify(a)).join(' ')}`,
    );

    this.setState('starting');
    const child = cp.spawn(command.command, args, {
      shell: command.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Electron fallback: run Code.exe as plain Node for bin.js.
      ...(command.electronAsNode ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
    });
    this.child = child;
    const instanceId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    let stdoutTail = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutTail = (stdoutTail + text).slice(-4000);
      const parsedPort = parsePortFromStream(text);
      if (parsedPort !== undefined) {
        this.options.logger.log(`[diagnostic] dsh stdout reports port ${parsedPort}`);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.options.logger.log(`[dsh stderr] ${chunk.toString('utf8').trimEnd()}`);
    });
    child.once('error', (error) => {
      this.options.logger.log(`[dsh] spawn error: ${String(error)}`);
    });
    child.once('exit', (code, signal) => {
      const tail = stdoutTail.trimEnd();
      this.options.logger.log(
        `dsh exited code=${code} signal=${signal}${tail ? ` lastStdout=${JSON.stringify(tail.slice(-500))}` : ''}`,
      );
      if (this.child === child) this.child = undefined;
      this.handleChildExit(code, signal);
    });

    const healthy = await waitForHealthy(port, START_TIMEOUT_MS, this.options.logger);
    if (this.child !== child) {
      // The child died during startup and the auto-restart took over: never
      // kill the replacement — report the state of the current attempt.
      if (this.state === 'ready' && this.instance) return this.getUrl()!;
      throw new DshError('dsh exited during startup and restarted; run the command again', 'START_FAILED');
    }
    if (!healthy) {
      await this.killChild(child);
      if (!this.disposed) {
        this.options.logger.log(`health probe timed out after ${START_TIMEOUT_MS}ms on port ${port}`);
        this.setState('failed');
        throw new DshError(
          `dsh server did not become healthy on 127.0.0.1:${port} within ${START_TIMEOUT_MS / 1000}s (see the DeepSeek Harness output channel)`,
          'START_TIMEOUT',
        );
      }
      throw new DshError('server manager disposed during startup', 'START_FAILED');
    }

    this.instance = { instanceId, pid: child.pid, port, startedAt };
    this.restartAttempted = false;
    this.options.logger.log(
      `dsh ready at http://${HOST}:${port} (pid=${child.pid} instance=${instanceId})`,
    );
    this.setState('ready', this.instance);
    for (const listener of [...this.readinessListeners]) listener(this.getUrl()!);
    return this.getUrl()!;
  }

  private async allocatePort(): Promise<number> {
    for (let attempt = 1; attempt <= PORT_RETRIES; attempt++) {
      const port = await pickFreePort();
      if (await healthProbe(port, 500)) {
        // Port was grabbed between probe and bind; try another one.
        this.options.logger.log(`port ${port} got taken after allocation (attempt ${attempt})`);
        continue;
      }
      return port;
    }
    throw new DshError(`could not allocate a free loopback port after ${PORT_RETRIES} attempts`, 'PORT_UNAVAILABLE');
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.disposed) return;
    if (this.intentionalExit) {
      this.intentionalExit = false;
      this.instance = undefined;
      if (this.state !== 'stopping' && this.state !== 'stopped') this.setState('failed');
      return;
    }
    if (this.state === 'stopping' || this.state === 'stopped') {
      this.instance = undefined;
      this.setState('stopped');
      return;
    }
    const expectedShutdown = this.state === 'idle';
    if (!expectedShutdown && !this.restartAttempted) {
      // Windows force-kill settles as a bare exit 1 without a signal marker;
      // treat unexpected exits as crashes and restart exactly once.
      this.restartAttempted = true;
      this.options.logger.log('dsh exited unexpectedly; restarting once...');
      this.instance = undefined;
      this.setState('failed');
      void this.start().catch((error) => {
        this.options.logger.log(`auto-restart failed: ${String(error)}`);
      });
      return;
    }
    this.instance = undefined;
    this.setState('failed');
    this.options.logger.log(`dsh stopped (code=${code} signal=${signal})`);
  }

  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') return;
    this.setState('stopping');
    const child = this.child;
    if (child) await this.killChild(child);
    this.instance = undefined;
    this.setState('stopped');
  }

  async restart(): Promise<string> {
    await this.stop();
    this.restartAttempted = false;
    return this.start();
  }

  private async killChild(child: cp.ChildProcess): Promise<void> {
    if (child.pid === undefined) return;
    this.intentionalExit = true;
    if (process.platform === 'win32') {
      try {
        cp.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        // best effort
      }
    } else {
      child.kill('SIGTERM');
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
    });
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS)),
    ]);
    if (timedOut && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
    }
  }

  private setState(state: ServerState, instance?: ServerInstance): void {
    this.state = state;
    this.options.onStateChange?.(state, instance);
    for (const listener of [...this.stateListeners]) listener(state, instance);
  }

  dispose(): void {
    this.disposed = true;
    const child = this.child;
    if (child) {
      this.setState('stopping');
      void this.killChild(child);
    }
    this.setState('stopped');
  }
}
