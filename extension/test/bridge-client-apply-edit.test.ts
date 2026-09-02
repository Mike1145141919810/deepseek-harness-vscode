import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

interface MessageEventLike { source: unknown; data: unknown }
interface Registration { factory(require: (id: string) => unknown): ClientExports }
interface WindowLike {
  parent: unknown;
  __ModuleLoader__: { load(registration: Registration): void };
  addEventListener(type: string, listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: string, listener: (event: MessageEventLike) => void): void;
}
interface Proposal {
  version: 1;
  requestId: string;
  file: string;
  beforeSha256: string;
  beforeText: string;
  afterText: string;
}
interface ApplyRequester {
  request(sessionId: string, proposal: Proposal): Promise<{ documentVersion: number }>;
  dispose(): void;
}
interface ClientExports {
  inject: string[];
  createApplyEditRequester(options: {
    windowObject: WindowLike;
    parentWindow: { postMessage(message: unknown, targetOrigin: string): void };
    timeoutMs?: number;
    setTimeout?: (callback: () => void, timeoutMs: number) => number;
    clearTimeout?: (timer: number) => void;
  }): ApplyRequester;
  applyProposalsDefinition: {
    match(event: Record<string, unknown>): { id: string; role: string } | null;
    start(context: unknown, match: { event: Record<string, unknown> }): {
      turn: number; proposals: unknown[];
    };
    update(
      context: { state: { turn: number; proposals: unknown[] } },
      match: { event: Record<string, unknown>; view?: unknown },
    ): { turn: number; proposals: unknown[] };
    buildLocationData(
      context: { state: { turn: number; proposals: unknown[] } },
      scope: string,
    ): unknown;
  };
  applyProposalsForClosing(data: unknown, seq?: number): Proposal[];
}

const proposal: Proposal = {
  version: 1,
  requestId: 'proposal-1',
  file: 'C:\\workspace\\sample.ts',
  beforeSha256: '8de5c07db8deb3b75dedd9b5bc999669936cea181ae0033c27c4e2071a6e434d',
  beforeText: 'const value = 1;\n',
  afterText: 'const value = 2;\n',
};

function loadClient(windowObject: WindowLike): ClientExports {
  let registration: Registration | undefined;
  windowObject.__ModuleLoader__.load = (value) => { registration = value; };
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'packages', 'dsh-vscode-bridge', 'lib', 'client.js'),
    'utf8',
  );
  vm.runInNewContext(source, { window: windowObject });
  assert.ok(registration);
  return registration.factory((id) => {
    if (id === 'react') return {};
    if (id === '@deepseek-ai/dsh-client-ui-deliverables/client') return {};
    if (id === '@deepseek-ai/dsh-client-runtime/client') return {
      isAppendSurfaceEvent: (event: { surfaceOp?: string }) => event.surfaceOp === 'append',
      resolveWorkspacePath: (cwd: string | undefined, file: string) =>
        cwd === undefined ? file : `${cwd}/${file}`,
    };
    throw new Error(`unexpected dependency: ${id}`);
  });
}

function harness() {
  const listeners = new Set<(event: MessageEventLike) => void>();
  const sent: Array<{ message: unknown; targetOrigin: string }> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const parentWindow = {
    postMessage(message: unknown, targetOrigin: string) {
      sent.push({ message, targetOrigin });
    },
  };
  const windowObject: WindowLike = {
    parent: parentWindow,
    __ModuleLoader__: { load: () => undefined },
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
  };
  const client = loadClient(windowObject);
  const requester = client.createApplyEditRequester({
    windowObject,
    parentWindow,
    timeoutMs: 5_000,
    setTimeout(callback) {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    client, requester, parentWindow, sent, timers,
    dispatch(event: MessageEventLike) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

describe('DSH client apply-edit requester', () => {
  it('posts one exact proposal and resolves only its correlated parent response', async () => {
    const test = harness();
    const pending = test.requester.request('session-1', proposal);
    assert.deepEqual(JSON.parse(JSON.stringify(test.sent)), [{
      message: {
        type: 'dsh:requestApplyEdit',
        ...proposal,
        sessionId: 'session-1',
      },
      targetOrigin: '*',
    }]);

    test.dispatch({
      source: {},
      data: {
        type: 'dsh:applyEditResult', requestId: proposal.requestId,
        sessionId: 'session-1', ok: true, documentVersion: 2,
      },
    });
    test.dispatch({
      source: test.parentWindow,
      data: {
        type: 'dsh:applyEditResult', requestId: proposal.requestId,
        sessionId: 'other', ok: true, documentVersion: 2,
      },
    });
    assert.equal(test.timers.size, 1);

    test.dispatch({
      source: test.parentWindow,
      data: {
        type: 'dsh:applyEditResult', requestId: proposal.requestId,
        sessionId: 'session-1', ok: true, documentVersion: 8,
      },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { documentVersion: 8 });
    assert.equal(test.timers.size, 0);
  });

  it('preserves structured VS Code rejection codes', async () => {
    const test = harness();
    const pending = test.requester.request('session-1', proposal);
    test.dispatch({
      source: test.parentWindow,
      data: {
        type: 'dsh:applyEditResult', requestId: proposal.requestId,
        sessionId: 'session-1', ok: false,
        error: { code: 'USER_CANCELLED', message: 'The edit was cancelled.' },
      },
    });
    await assert.rejects(pending, (error: Error & { code?: string }) => {
      assert.equal(error.name, 'ApplyEditBridgeError');
      assert.equal(error.code, 'USER_CANCELLED');
      assert.equal(error.message, 'The edit was cancelled.');
      return true;
    });
  });

  it('rejects malformed/oversized proposals before crossing the parent boundary', async () => {
    const test = harness();
    const malformed = [
      { ...proposal, version: 2 },
      { ...proposal, requestId: ' bad ' },
      { ...proposal, file: 'x'.repeat(32_769) },
      { ...proposal, beforeSha256: 'bad' },
      { ...proposal, afterText: proposal.beforeText },
      { ...proposal, afterText: 'x'.repeat(1_048_577) },
      { ...proposal, extra: true },
    ];
    for (const candidate of malformed) {
      await assert.rejects(
        test.requester.request('session-1', candidate as Proposal),
        (error: Error & { code?: string }) => error.code === 'INVALID_REQUEST',
      );
    }
    assert.equal(test.sent.length, 0);
  });

  it('times out safely and rejects all pending work when disposed', async () => {
    const test = harness();
    const timedOut = test.requester.request('session-1', proposal);
    [...test.timers.values()][0]!();
    await assert.rejects(timedOut, (error: Error & { code?: string }) =>
      error.code === 'APPLY_EDIT_TIMEOUT');

    const second = { ...proposal, requestId: 'proposal-2' };
    const pending = test.requester.request('session-1', second);
    test.requester.dispose();
    await assert.rejects(pending, (error: Error & { code?: string }) =>
      error.code === 'BRIDGE_DISPOSED');
  });
});

describe('DSH client apply-proposal turn data', () => {
  it('collects only successful proposal result views and honors the closing sequence', () => {
    const client = harness().client;
    const startEvent = { type: 'turn/start', data: { turn: 3 } };
    const initial = client.applyProposalsDefinition.start({}, { event: startEvent });
    const resultEvent = {
      type: 'tool/result', seq: 9, surfaceOp: 'append',
      data: { turn: 3, message: { content: [{ isError: false }] } },
    };
    const updated = client.applyProposalsDefinition.update(
      { state: initial },
      { event: resultEvent, view: { for: 'result', view: { dshVscodeApplyProposal: proposal } } },
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(client.applyProposalsForClosing(
        { proposals: [...updated.proposals, { seq: 10, ...proposal, requestId: 'later' }] },
        9,
      ))),
      [proposal],
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(client.applyProposalsDefinition.buildLocationData(
        { state: updated },
        'turn',
      ))),
      {
        kind: 'turn', turn: 3, key: 'dshVscodeApplyProposals',
        value: { proposals: [{ seq: 9, ...proposal }] },
      },
    );
  });

  it('wires an explicit apply button into the turn tail', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'packages', 'dsh-vscode-bridge', 'lib', 'client.js'),
      'utf8',
    );
    assert.match(source, /data-dsh-vscode-apply/);
    assert.match(source, /select: selectApplyProposals/);
    assert.match(source, /createApplyEditRequester/);
  });
});
