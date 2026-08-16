/**
 * Persisted record of the last running dsh server instance.
 *
 * Written on every successful start and removed on a clean shutdown. On the
 * next start the record enables stale detection: a dead PID (or a live PID
 * whose port no longer answers) means the previous session did not clean up.
 *
 * Pure Node module (no `vscode` import) — unit testable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface InstanceRecord {
  v: 1;
  instanceId: string;
  pid: number;
  port: number;
  startedAt: string;
}

export function recordPath(stateDir: string): string {
  return path.join(stateDir, 'dsh-server.json');
}

/** Load the record, tolerating missing files and corrupt/foreign JSON. */
export function loadInstanceRecord(stateDir: string): InstanceRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath(stateDir), 'utf8')) as Partial<InstanceRecord>;
    if (
      parsed.v !== 1 ||
      typeof parsed.instanceId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return undefined;
    }
    return {
      v: 1,
      instanceId: parsed.instanceId,
      pid: parsed.pid,
      port: parsed.port,
      startedAt: parsed.startedAt,
    };
  } catch {
    return undefined;
  }
}

export function saveInstanceRecord(stateDir: string, record: InstanceRecord): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(recordPath(stateDir), JSON.stringify(record, null, 2));
}

export function clearInstanceRecord(stateDir: string): void {
  try {
    fs.rmSync(recordPath(stateDir), { force: true });
  } catch {
    // Best effort: a leftover record only costs a stale-detection warning.
  }
}

/** Existence check via signal 0; EPERM means the PID exists but is foreign. */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
