/**
 * Seeds the DSH workspace registry with a directory path before the GUI
 * loads, so the VS Code workspace folder is already a DSH workspace when the
 * panel opens (the GUI auto-connects the most recent workspace on boot).
 *
 * Pure Node module (no `vscode` import) — unit/integration testable.
 */
import * as crypto from 'node:crypto';

export interface SeedOutcome {
  path: string;
  ok: boolean;
  detail: string;
  workspaceId?: string;
  created?: boolean;
}

interface RpcValue {
  workspace?: { workspaceId?: string };
  created?: boolean;
}

interface RpcEnvelope {
  rpcId?: string;
  result?: {
    ok?: boolean;
    value?: RpcValue;
    error?: { message?: string; code?: string };
  };
}

/** POST one client-request envelope and return the parsed result part. */
async function rpcCall(
  baseUrl: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; detail: string; value?: RpcValue }> {
  const rpcId = crypto.randomUUID();
  const body = { type: 'client-request', rpcId, method, payload };
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
  const envelope = (await response.json()) as RpcEnvelope;
  if (envelope.rpcId !== rpcId) return { ok: false, detail: 'rpcId mismatch' };
  if (!envelope.result?.ok) {
    const error = envelope.result?.error;
    return { ok: false, detail: error?.message ?? error?.code ?? 'unknown rpc error' };
  }
  return { ok: true, detail: 'ok', value: envelope.result.value };
}

/**
 * Register (or idempotently resolve) a workspace via the host RPC.
 * Wire format: POST /api/<method> with a client-request envelope.
 */
export async function seedWorkspace(baseUrl: string, folderPath: string): Promise<SeedOutcome> {
  try {
    const result = await rpcCall(baseUrl, 'workspace.create', { path: folderPath });
    if (!result.ok) return { path: folderPath, ok: false, detail: result.detail };
    return {
      path: folderPath,
      ok: true,
      detail: result.value?.created ? 'created' : 'existing',
      workspaceId: result.value?.workspace?.workspaceId,
      created: result.value?.created,
    };
  } catch (error) {
    return { path: folderPath, ok: false, detail: String(error) };
  }
}

/** Remove a workspace registration (the directory itself is never touched). */
export async function deleteWorkspace(baseUrl: string, workspaceId: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await rpcCall(baseUrl, 'workspace.delete', { workspaceId });
    return { ok: result.ok, detail: result.detail };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
}

/**
 * Seed several folders. Iterates in reverse so the FIRST VS Code folder ends
 * up as the newest workspace (create prepends new records), matching the
 * editor's primary folder semantics for the GUI's auto-selection.
 */
export async function seedWorkspaces(baseUrl: string, folderPaths: string[]): Promise<SeedOutcome[]> {
  const outcomes: SeedOutcome[] = [];
  for (const folderPath of [...folderPaths].reverse()) {
    outcomes.push(await seedWorkspace(baseUrl, folderPath));
  }
  return outcomes;
}
