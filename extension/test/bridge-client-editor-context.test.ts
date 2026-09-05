import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

interface MessageEventLike {
  source: unknown;
  data: unknown;
}

interface ClientWindowLike {
  parent: unknown;
  __ModuleLoader__: { load(registration: ClientRegistration): void };
  addEventListener(type: string, listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: string, listener: (event: MessageEventLike) => void): void;
}

interface ClientRegistration {
  factory(require: (id: string) => unknown): ClientExports;
}

interface EditorContextRequester {
  request(sessionId: string): Promise<Record<string, unknown>>;
  dispose(): void;
}

interface ClientExports {
  inject: string[];
  diffPreviewsDefinition: {
    match(event: Record<string, unknown>): { id: string; role: string } | null;
    start(context: unknown, match: { event: Record<string, unknown> }): {
      turn: number;
      changes: unknown[];
    };
    update(
      context: { state: { turn: number; changes: unknown[] } },
      match: { event: Record<string, unknown>; view?: unknown },
    ): { turn: number; changes: unknown[] };
    buildLocationData(
      context: { state: { turn: number; changes: unknown[] } },
      scope: string,
    ): unknown;
  };
  diffPreviewsForClosing(
    data: unknown,
    seq?: number,
  ): Array<{ path: string; diffs: Array<{ oldText: string | null; newText: string }> }>;
  postDiffPreview(
    parentWindow: { postMessage(message: unknown, targetOrigin: string): void },
    cwd: string | undefined,
    preview: { path: string; diffs: Array<{ oldText: string | null; newText: string }> },
  ): void;
  createEditorContextRequester(options: {
    windowObject: ClientWindowLike;
    parentWindow: { postMessage(message: unknown, targetOrigin: string): void };
    createRequestId: () => string;
    timeoutMs?: number;
    setTimeout?: (callback: () => void, timeoutMs: number) => number;
    clearTimeout?: (timer: number) => void;
  }): EditorContextRequester;
  shareEditorContextWithSession(
    requester: { request(sessionId: string): Promise<Record<string, unknown>> },
    sessionId: string,
    sessionForId: (sessionId: string) => undefined | {
      command(line: string): Promise<unknown>;
    },
  ): Promise<{ kind: 'file' | 'selection' }>;
}

function loadClientModule(windowObject: ClientWindowLike): ClientExports {
  let registration: ClientRegistration | undefined;
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
    throw new Error(`unexpected client dependency: ${id}`);
  });
}

function loadActionClient(): ClientExports {
  const parentWindow = { postMessage: () => undefined };
  return loadClientModule({
    parent: parentWindow,
    __ModuleLoader__: { load: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
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
  const windowObject: ClientWindowLike = {
    parent: parentWindow,
    __ModuleLoader__: { load: () => undefined },
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener);
    },
  };
  const client = loadClientModule(windowObject);
  const requester = client.createEditorContextRequester({
    windowObject,
    parentWindow,
    createRequestId: () => 'request-1',
    timeoutMs: 5_000,
    setTimeout(callback) {
      const timer = nextTimer;
      nextTimer += 1;
      timers.set(timer, callback);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
  });
  return {
    requester,
    parentWindow,
    sent,
    timers,
    dispatch(event: MessageEventLike) {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

describe('DSH client editor-context requester', () => {
  it('posts one correlated request and resolves only the exact parent/session response', async () => {
    const test = harness();
    const result = test.requester.request('session-1');
    const normalizedSent = JSON.parse(JSON.stringify(test.sent)) as unknown;
    assert.deepEqual(normalizedSent, [{
      message: {
        type: 'dsh:requestEditorContext',
        requestId: 'request-1',
        sessionId: 'session-1',
      },
      targetOrigin: '*',
    }]);

    test.dispatch({
      source: {},
      data: {
        type: 'dsh:editorContext', requestId: 'request-1', sessionId: 'session-1', ok: true,
        context: { version: 99 },
      },
    });
    test.dispatch({
      source: test.parentWindow,
      data: {
        type: 'dsh:editorContext', requestId: 'request-1', sessionId: 'other-session', ok: true,
        context: { version: 99 },
      },
    });
    assert.equal(test.timers.size, 1);

    const context = { version: 1, file: 'sample.ts' };
    test.dispatch({
      source: test.parentWindow,
      data: {
        type: 'dsh:editorContext', requestId: 'request-1', sessionId: 'session-1', ok: true, context,
      },
    });
    assert.deepEqual(await result, context);
    assert.equal(test.timers.size, 0);
  });

  it('preserves a structured VS Code error code', async () => {
    const test = harness();
    const result = test.requester.request('session-1');
    test.dispatch({
      source: test.parentWindow,
      data: {
        type: 'dsh:editorContext',
        requestId: 'request-1',
        sessionId: 'session-1',
        ok: false,
        error: { code: 'NO_EDITOR_CONTEXT', message: 'No local editor is open.' },
      },
    });
    await assert.rejects(result, (error: Error & { code?: string }) => {
      assert.equal(error.name, 'EditorContextBridgeError');
      assert.equal(error.code, 'NO_EDITOR_CONTEXT');
      assert.equal(error.message, 'No local editor is open.');
      return true;
    });
  });

  it('times out unmatched requests and clears its listener when disposed', async () => {
    const test = harness();
    const timedOut = test.requester.request('session-1');
    const timeout = [...test.timers.values()][0];
    assert.ok(timeout);
    timeout();
    await assert.rejects(timedOut, (error: Error & { code?: string }) => {
      assert.equal(error.code, 'EDITOR_CONTEXT_TIMEOUT');
      return true;
    });

    const pending = test.requester.request('session-2');
    assert.equal(test.listenerCount(), 1);
    test.requester.dispose();
    assert.equal(test.listenerCount(), 0);
    await assert.rejects(pending, (error: Error & { code?: string }) => {
      assert.equal(error.code, 'BRIDGE_DISPOSED');
      return true;
    });
    await assert.rejects(test.requester.request('session-3'), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'BRIDGE_DISPOSED');
      return true;
    });
  });

  it('rejects invalid session IDs before posting a request', async () => {
    const test = harness();
    await assert.rejects(test.requester.request(' bad-session '), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INVALID_SESSION_ID');
      return true;
    });
    assert.equal(test.sent.length, 0);
  });
});

describe('DSH client editor-context command wiring', () => {
  it('requests the exact session and submits its selection through SessionFace.command', async () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'packages', 'dsh-vscode-bridge', 'lib', 'client.js'),
      'utf8',
    );
    assert.match(source, /slots\.inject\("conversation\.input\.left"/);
    assert.match(source, /data-dsh-vscode-context/);
    const client = loadActionClient();
    assert.deepEqual(
      [...client.inject],
      ['slots', 'locale', 'connection', 'sessions', 'conversationEvents'],
    );
    const calls: string[] = [];
    const context = {
      version: 1,
      file: 'C:\\workspace\\sample.ts',
      selection: { text: 'selected text' },
    };
    const shared = await client.shareEditorContextWithSession(
      { request: async (sessionId) => {
        assert.equal(sessionId, 'session-1');
        return context;
      } },
      'session-1',
      (sessionId) => sessionId === 'session-1' ? {
        async command(line) {
          calls.push(line);
          return { ok: true, value: { matched: true } };
        },
      } : undefined,
    );

    assert.equal(shared.kind, 'selection');
    assert.deepEqual(calls, [`/vscode-context ${JSON.stringify(context)}`]);
  });

  it('reports file-only snapshots after a matched command', async () => {
    const client = loadActionClient();
    const shared = await client.shareEditorContextWithSession(
      { request: async () => ({ version: 1, file: 'C:\\workspace\\sample.ts' }) },
      'session-1',
      () => ({ command: async () => ({ ok: true, value: { matched: true } }) }),
    );
    assert.equal(shared.kind, 'file');
  });

  it('does not read VS Code context without a live session and rejects an unmatched command', async () => {
    const client = loadActionClient();
    let requests = 0;
    const requester = { request: async () => { requests += 1; return {}; } };
    await assert.rejects(
      client.shareEditorContextWithSession(requester, 'missing', () => undefined),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'SESSION_UNAVAILABLE');
        return true;
      },
    );
    assert.equal(requests, 0);

    await assert.rejects(
      client.shareEditorContextWithSession(
        requester,
        'session-1',
        () => ({ command: async () => ({ ok: true, value: { matched: false } }) }),
      ),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'VSCODE_CONTEXT_COMMAND_UNAVAILABLE');
        return true;
      },
    );
  });

  it('preserves command transport failures for button feedback', async () => {
    const client = loadActionClient();
    await assert.rejects(
      client.shareEditorContextWithSession(
        { request: async () => ({ version: 1 }) },
        'session-1',
        () => ({
          command: async () => ({
            ok: false,
            error: { code: 'transport-closed', message: 'Connection closed.', details: {} },
          }),
        }),
      ),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'transport-closed');
        assert.equal(error.message, 'Connection closed.');
        return true;
      },
    );
  });
});

describe('DSH client diff-preview wiring', () => {
  it('collects only successful append-surface result diffs and publishes turn data', () => {
    const client = loadActionClient();
    const startEvent = { type: 'turn/start', data: { turn: 7 } };
    const startMatch = { event: startEvent };
    assert.deepEqual(
      JSON.parse(JSON.stringify(client.diffPreviewsDefinition.match(startEvent))),
      { id: '7', role: 'start' },
    );
    const initial = client.diffPreviewsDefinition.start({}, startMatch);

    const resultEvent = {
      type: 'tool/result',
      seq: 14,
      surfaceOp: 'append',
      data: { turn: 7, message: { content: [{ isError: false }] } },
    };
    assert.deepEqual(
      JSON.parse(JSON.stringify(client.diffPreviewsDefinition.match(resultEvent))),
      { id: '7', role: 'update' },
    );
    const updated = client.diffPreviewsDefinition.update(
      { state: initial },
      {
        event: resultEvent,
        view: {
          for: 'result',
          view: {
            card: 'diff',
            diffs: [
              { path: 'src/a.ts', oldText: 'one\n', newText: 'two\n' },
              { path: 'src/a.ts', oldText: 'three\n', newText: 'four\n' },
            ],
          },
        },
      },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(updated.changes)), [
      { seq: 14, path: 'src/a.ts', oldText: 'one\n', newText: 'two\n' },
      { seq: 14, path: 'src/a.ts', oldText: 'three\n', newText: 'four\n' },
    ]);
    assert.deepEqual(
      JSON.parse(JSON.stringify(client.diffPreviewsDefinition.buildLocationData(
        { state: updated },
        'turn',
      ))),
      {
        kind: 'turn',
        turn: 7,
        key: 'dsh-vscode-diff-previews',
        value: {
          changes: [
            { seq: 14, path: 'src/a.ts', oldText: 'one\n', newText: 'two\n' },
            { seq: 14, path: 'src/a.ts', oldText: 'three\n', newText: 'four\n' },
          ],
        },
      },
    );
    assert.equal(
      client.diffPreviewsDefinition.match({ ...resultEvent, surfaceOp: 'replace' }),
      null,
    );
  });

  it('groups applied hunks by file and honors the closing sequence boundary', () => {
    const client = loadActionClient();
    const previews = client.diffPreviewsForClosing({
      changes: [
        { seq: 2, path: 'src/a.ts', oldText: 'a', newText: 'b' },
        { seq: 3, path: 'src/b.ts', oldText: null, newText: 'new' },
        { seq: 4, path: 'src/a.ts', oldText: 'b', newText: 'c' },
      ],
    }, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(previews)), [
      { path: 'src/a.ts', diffs: [{ oldText: 'a', newText: 'b' }] },
      { path: 'src/b.ts', diffs: [{ oldText: null, newText: 'new' }] },
    ]);
  });

  it('posts a strict read-only request with an absolute workspace path', () => {
    const client = loadActionClient();
    const sent: Array<{ message: unknown; targetOrigin: string }> = [];
    client.postDiffPreview(
      {
        postMessage(message, targetOrigin) {
          sent.push({ message, targetOrigin });
        },
      },
      'C:\\workspace',
      {
        path: 'src/a.ts',
        diffs: [{ oldText: 'before', newText: 'after' }],
      },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
      message: {
        type: 'dsh:previewDiff',
        file: 'C:\\workspace/src/a.ts',
        diffs: [{ oldText: 'before', newText: 'after' }],
      },
      targetOrigin: '*',
    }]);

    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'packages', 'dsh-vscode-bridge', 'lib', 'client.js'),
      'utf8',
    );
    assert.match(source, /data-dsh-vscode-diff/);
    assert.match(source, /previewDiffInVSCode/);
  });
});
