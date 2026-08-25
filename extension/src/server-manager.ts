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
import { clearInstanceRecord, loadInstanceRecord, pidIsAlive, saveInstanceRecord } from './instance-record';
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
  return findAllOnPath(name, win, pathEnv)[0];
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

  const onPath = pickPathCandidate(await findOnPath('dsh', win, pathEnv), win);
  if (onPath) {
    if (win && !/\.exe$/i.test(onPath)) {
      // npm/npx shims are trampolines to a node script. Resolve that script
      // and run it directly with a real node: this sidesteps `shell: true`
      // entirely (spaces in the user profile path split the command line,
      // and cmd gets args unquoted/concatenated — see DEP0190).
      const script = resolveShimScript(onPath);
      if (script !== undefined) {
        if (!exists(script)) {
          throw new DshError(
            `dsh shim at "${onPath}" points to a missing script (${script}) — likely a stale npx cache; set dsh.binPath to a valid lib/bin.js or reinstall dsh`,
            'DSH_NOT_FOUND',
          );
        }
        const node = resolveNodeBinary(pathEnv, platform);
        return {
          kind: 'node-bin',
          command: node.command,
          args: [script],
          shell: false,
          electronAsNode: node.electronAsNode,
        };
      }
    }
    // Anything except a native .exe must run through a shell on Windows.
    // npm/npx shims were resolved above; a remaining .cmd path is quoted so
    // spaces in the path don't split the command line for cmd.exe.
    const needsShell = win && !/\.exe$/i.test(onPath);
    const command = needsShell && /\s/.test(onPath) && !onPath.startsWith('"') ? `"${onPath}"` : onPath;
    return { kind: 'path', command, args: [], shell: needsShell };
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

async function findOnPath(name: string, win: boolean, pathEnv: string): Promise<string[]> {
  return findAllOnPath(name, win, pathEnv);
}

/**
 * Search an explicit PATH without spawning `where`/`which`.
 *
 * On Windows, environment keys are case-insensitive but Node can retain both
 * `Path` and `PATH` in the object passed to a child process. Which value wins
 * is undefined, so `where` could silently search the extension host's PATH
 * instead of the caller-supplied one. Direct filesystem lookup makes the
 * injected PATH authoritative and keeps discovery deterministic in tests and
 * in VS Code.
 */
function findAllOnPath(name: string, win: boolean, pathEnv: string): string[] {
  const delimiter = win ? path.win32.delimiter : path.posix.delimiter;
  const hasExtension = path.extname(name) !== '';
  const names = hasExtension
    ? [name]
    : win
      ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.ps1`, `${name}.com`]
      : [name];
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const rawEntry of pathEnv.split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1');
    if (entry === '') continue;
    for (const candidateName of names) {
      const candidate = path.resolve(entry, candidateName);
      const key = win ? candidate.toLowerCase() : candidate;
      if (seen.has(key) || !exists(candidate)) continue;
      if (!win) {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      seen.add(key);
      matches.push(candidate);
    }
  }
  return matches;
}

/**
 * Pick the runnable candidate among PATH matches.
 *
 * On Windows `where dsh` lists the extensionless npm shim (a POSIX sh script
 * that cmd cannot execute) BEFORE `dsh.cmd`. Prefer a native .exe, then a
 * .cmd/.bat/.ps1 shim, and only fall back to the first match otherwise.
 */
export function pickPathCandidate(matches: string[], win: boolean): string | undefined {
  if (matches.length === 0) return undefined;
  if (!win) return matches[0];
  for (const ext of ['exe', 'cmd', 'bat', 'ps1']) {
    const hit = matches.find((m) => m.toLowerCase().endsWith(`.${ext}`));
    if (hit !== undefined) return hit;
  }
  return matches[0];
}

/**
 * Resolve the real node script behind an npm/npx shim.
 *
 * Windows npm creates three trampolines: `x.cmd` (`"%dp0%\..\pkg\lib\bin.js"`),
 * `x.ps1` and the extensionless sh script (`"$basedir/../pkg/lib/bin.js"`).
 * Returns the absolute script path, or undefined when the file is not a
 * recognizable npm shim.
 */
export function resolveShimScript(shimPath: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return undefined;
  }
  const dir = path.dirname(shimPath);
  const lower = shimPath.toLowerCase();

  let rel: string | undefined;
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    // npm cmd-shim, two layouts: inside node_modules/.bin it points at
    // "%dp0%\..\@scope\pkg\lib\bin.js"; in the npm prefix dir (npm >= 10) at
    // "%dp0%\node_modules\@scope\pkg\lib\bin.js" (no ".." segment).
    const candidates = [...content.matchAll(/"%dp0%(\\.+?\.js)"/gi)].map((m) => m[1]);
    rel = candidates.find((candidate) => candidate.includes('\\..\\')) ?? candidates[0];
  } else {
    // sh / ps1 shims: "$basedir/../@scope/pkg/lib/bin.js"
    const match = /\$basedir\/(\.\.\/[^"\s]+\.js)/.exec(content);
    if (match) rel = match[1].replace(/\//g, path.sep);
  }

  if (!rel) return undefined;
  // `%dp0%` already ends with a separator; strip the leading separator so the
  // `..` segment resolves relative to the shim directory, not the drive root.
  return path.resolve(dir, rel.replace(/^[\\/]+/, ''));
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
  /** Directory (e.g. globalStorage) for the persisted instance record; disabled when absent. */
  recordDir?: string;
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
  /** True when the current instance was spawned by THIS manager (not adopted). */
  private ownsServer = false;
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

    // Stale detection before every cold start: warn about a still-running
    // previous instance, clear records whose PID is dead or port gone.
    await this.detectStaleRecord();

    // Cross-window singleton: if another window already runs a live dsh,
    // adopt it instead of spawning a second server.
    if (await this.adoptLiveInstance()) return this.getUrl()!;

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
    let spawnErrorDetail = '';
    let spawnErrorCode = '';
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
      spawnErrorDetail = String(error);
      spawnErrorCode = (error as NodeJS.ErrnoException).code ?? '';
      this.options.logger.log(`[dsh] spawn error: ${spawnErrorDetail}`);
    });
    child.once('exit', (code, signal) => {
      const tail = stdoutTail.trimEnd();
      this.options.logger.log(
        `dsh exited code=${code} signal=${signal}${tail ? ` lastStdout=${JSON.stringify(tail.slice(-500))}` : ''}`,
      );
      // Guard against a late `exit` after a spawn `error` already settled the
      // attempt (in that path `this.child` was cleared and no restart wanted).
      if (this.child === child) {
        this.child = undefined;
        this.handleChildExit(code, signal);
      }
    });

    // Fail fast when the executable itself cannot be spawned (missing binary,
    // stale shim, ...) instead of waiting out the whole health timeout.
    const startup = await Promise.race([
      waitForHealthy(port, START_TIMEOUT_MS, this.options.logger).then(
        (ok): 'healthy' | 'timeout' => (ok ? 'healthy' : 'timeout'),
      ),
      new Promise<'spawn-error'>((resolve) => {
        child.once('error', () => resolve('spawn-error'));
      }),
    ]);
    if (startup === 'spawn-error') {
      if (this.child === child) this.child = undefined;
      this.setState('failed');
      const staleHint =
        spawnErrorCode === 'ENOENT'
          ? ' — the resolved dsh executable is missing or a stale shim (run DSH: Check Installation, or set dsh.binPath to a valid dsh lib/bin.js)'
          : '';
      throw new DshError(`could not launch the dsh process: ${spawnErrorDetail}${staleHint}`, 'START_FAILED');
    }
    if (this.child !== child) {
      // The child died during startup and the auto-restart took over: never
      // kill the replacement — report the state of the current attempt.
      if (this.state === 'ready' && this.instance) return this.getUrl()!;
      throw new DshError('dsh exited during startup and restarted; run the command again', 'START_FAILED');
    }
    if (startup === 'timeout') {
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

    // A concurrent window may have published a live record while we were
    // starting. Prefer the shared instance and drop our duplicate process.
    if (await this.adoptLiveInstance()) {
      this.options.logger.log('another window won the start race; stopping our duplicate');
      if (this.child === child) this.child = undefined; // suppress exit-handler cleanup
      await this.killChild(child);
      this.intentionalExit = false;
      await this.adoptLiveInstance();
      return this.getUrl()!;
    }

    this.instance = { instanceId, pid: child.pid, port, startedAt };
    this.ownsServer = true;
    this.restartAttempted = false;
    this.persistRecord(this.instance);
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

  /**
   * Stale detection for the record persisted by a previous session: warn when
   * that instance is still running, otherwise clear the record.
   */
  private async detectStaleRecord(): Promise<void> {
    const dir = this.options.recordDir;
    if (!dir) return;
    const record = loadInstanceRecord(dir);
    if (!record) return;
    const alive = pidIsAlive(record.pid);
    const serving = alive && (await healthProbe(record.port, 1000));
    if (alive && serving) {
      this.options.logger.log(
        `[stale] a dsh instance from a previous session is still running (pid=${record.pid} port=${record.port} instance=${record.instanceId}) — leaving it alone`,
      );
      return;
    }
    clearInstanceRecord(dir);
    this.options.logger.log(
      `[stale] cleared stale dsh instance record (pid=${record.pid} port=${record.port}; ${
        alive ? 'port no longer answering' : 'pid is dead'
      })`,
    );
  }

  /**
   * Cross-window singleton: if the persisted record points at a live server
   * (same machine, port answering), adopt it as the current instance instead
   * of spawning a new one. Adoption windows never kill or remove the record.
   */
  private async adoptLiveInstance(): Promise<boolean> {
    const dir = this.options.recordDir;
    if (!dir) return false;
    const record = loadInstanceRecord(dir);
    if (!record) return false;
    if (!pidIsAlive(record.pid)) return false;
    if (!(await healthProbe(record.port, 1000))) return false;
    this.instance = {
      instanceId: record.instanceId,
      pid: record.pid,
      port: record.port,
      startedAt: record.startedAt,
    };
    this.ownsServer = false;
    this.restartAttempted = false;
    this.setState('ready', this.instance);
    this.options.logger.log(
      `reusing existing dsh instance from another window (pid=${record.pid} port=${record.port} instance=${record.instanceId})`,
    );
    return true;
  }

  private persistRecord(instance: ServerInstance): void {
    const dir = this.options.recordDir;
    if (!dir || instance.pid === undefined) return;
    try {
      saveInstanceRecord(dir, {
        v: 1,
        instanceId: instance.instanceId,
        pid: instance.pid,
        port: instance.port,
        startedAt: instance.startedAt,
      });
    } catch (error) {
      this.options.logger.log(`[record] could not persist instance record: ${String(error)}`);
    }
  }

  private removeRecord(): void {
    const dir = this.options.recordDir;
    if (!dir) return;
    clearInstanceRecord(dir);
  }

  /** After killing the child, confirm the port stopped answering. If another
   * process grabbed it meanwhile, warn — never kill a process we don't own. */
  private async verifyPortReleased(port: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await healthProbe(port, 500))) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.options.logger.log(
      `[warn] port ${port} still answers after dsh shutdown — another process may have grabbed it; it was left alone`,
    );
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.disposed) return;
    if (this.intentionalExit) {
      this.intentionalExit = false;
      this.instance = undefined;
      this.removeRecord();
      if (this.state !== 'stopping' && this.state !== 'stopped') this.setState('failed');
      return;
    }
    if (this.state === 'stopping' || this.state === 'stopped') {
      this.instance = undefined;
      this.removeRecord();
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
      this.removeRecord();
      this.setState('failed');
      void this.start().catch((error) => {
        this.options.logger.log(`auto-restart failed: ${String(error)}`);
      });
      return;
    }
    this.instance = undefined;
    this.removeRecord();
    this.setState('failed');
    this.options.logger.log(`dsh stopped (code=${code} signal=${signal})`);
  }

  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') {
      if (this.ownsServer) this.removeRecord();
      return;
    }
    this.setState('stopping');
    const child = this.child;
    const instance = this.instance;
    if (!this.ownsServer) {
      // Shared server is owned by another window: only detach.
      this.instance = undefined;
      this.setState('stopped');
      this.options.logger.log(`detached from shared dsh instance (port=${instance?.port})`);
      return;
    }
    if (child) await this.killChild(child);
    if (instance) await this.verifyPortReleased(instance.port);
    this.instance = undefined;
    this.removeRecord();
    this.setState('stopped');
  }

  async restart(): Promise<string> {
    const sharedPid = this.instance?.pid;
    const owned = this.ownsServer;
    await this.stop();
    if (!owned && sharedPid !== undefined) {
      // Restarting a server owned by another window: kill it by PID and clear
      // the record so this window spawns a fresh one. Any other window's
      // auto-restart converges through the same record-adoption logic.
      this.options.logger.log(`restarting shared dsh instance (pid=${sharedPid})`);
      await this.killPid(sharedPid);
      this.removeRecord();
      this.ownsServer = true;
    }
    this.restartAttempted = false;
    return this.start();
  }

  /** Tree-kill a process by PID (used when restarting a shared instance). */
  private async killPid(pid: number): Promise<void> {
    if (!pid) return;
    if (process.platform === 'win32') {
      try {
        cp.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        // best effort
      }
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // best effort
    }
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // best effort
    }
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
    if (child && this.ownsServer) {
      this.setState('stopping');
      void this.killChild(child).finally(() => this.removeRecord());
    } else if (this.ownsServer) {
      this.removeRecord();
    }
    // Adopted shared instances are left alone on dispose.
    this.setState('stopped');
  }
}
