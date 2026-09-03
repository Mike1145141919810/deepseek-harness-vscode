import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

interface Registration {
  factory(require: (id: string) => unknown): ClientExports;
}

interface ClientExports {
  createSessionHealthWatchdog(options: {
    windowObject: { parent: unknown };
    api: {
      sessions: {
        list(): Promise<unknown>;
      };
    };
    sessions: {
      list: { getSnapshot(): { current?: string } };
      binding(id: string): { session: { getSnapshot(): { running: boolean } } } | undefined;
    };
    intervalMs?: number;
    confirmations?: number;
    setTimeout(callback: () => void, timeoutMs: number): number;
    clearTimeout(timer: number): void;
    reload(): void;
    isVisible?(): boolean;
  }): { dispose(): void };
}

function loadClient(windowObject: { parent: unknown }): ClientExports {
  let registration: Registration | undefined;
  const windowWithLoader = {
    ...windowObject,
    __ModuleLoader__: {
      load(value: Registration) { registration = value; },
    },
  };
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'packages', 'dsh-vscode-bridge', 'lib', 'client.js'),
    'utf8',
  );
  vm.runInNewContext(source, { window: windowWithLoader, console });
  assert.ok(registration);
  return registration.factory((id) => {
    if (id === 'react') return {};
    if (id === '@deepseek-ai/dsh-client-ui-deliverables/client') return {};
    if (id === '@deepseek-ai/dsh-client-runtime/client') return {};
    throw new Error(`unexpected dependency: ${id}`);
  });
}

function harness() {
  const parent = {};
  const windowObject = { parent };
  const client = loadClient(windowObject);
  const timers = new Map<number, () => void | Promise<void>>();
  let nextTimer = 1;
  let current: string | undefined = 'session-1';
  let localRunning = true;
  let authoritativeRunning = false;
  let reloads = 0;
  const watchdog = client.createSessionHealthWatchdog({
    windowObject,
    api: {
      sessions: {
        async list() {
          return {
            result: {
              ok: true,
              value: {
                items: current === undefined ? [] : [{ sessionId: current, running: authoritativeRunning }],
              },
            },
          };
        },
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ current }) },
      binding(id) {
        return id === current
          ? { session: { getSnapshot: () => ({ running: localRunning }) } }
          : undefined;
      },
    },
    intervalMs: 1,
    confirmations: 2,
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    reload() { reloads += 1; },
  });

  return {
    watchdog,
    timers,
    reloads: () => reloads,
    setCurrent(value: string | undefined) { current = value; },
    setLocalRunning(value: boolean) { localRunning = value; },
    setAuthoritativeRunning(value: boolean) { authoritativeRunning = value; },
    async tick() {
      const entry = timers.entries().next().value as [number, () => void | Promise<void>] | undefined;
      assert.ok(entry, 'watchdog timer should be scheduled');
      timers.delete(entry[0]);
      await entry[1]();
    },
  };
}

describe('DSH embedded session health watchdog', () => {
  it('reloads only after two consecutive authoritative idle mismatches', async () => {
    const test = harness();
    await test.tick();
    assert.equal(test.reloads(), 0);
    await test.tick();
    assert.equal(test.reloads(), 1);
    assert.equal(test.timers.size, 0, 'a recovery reload must stop the watchdog');
  });

  it('resets mismatch evidence when Host or local state agrees', async () => {
    const test = harness();
    await test.tick();
    test.setAuthoritativeRunning(true);
    await test.tick();
    test.setAuthoritativeRunning(false);
    await test.tick();
    assert.equal(test.reloads(), 0, 'one mismatch after agreement is insufficient');
    test.setLocalRunning(false);
    await test.tick();
    test.setLocalRunning(true);
    await test.tick();
    assert.equal(test.reloads(), 0, 'a locally idle observation resets mismatch evidence');
    test.watchdog.dispose();
    assert.equal(test.timers.size, 0);
  });

  it('does not schedule outside an embedding parent', () => {
    const self: { parent?: unknown } = {};
    self.parent = self;
    const client = loadClient(self as { parent: unknown });
    let scheduled = 0;
    const watchdog = client.createSessionHealthWatchdog({
      windowObject: self as { parent: unknown },
      api: { sessions: { list: async () => ({}) } },
      sessions: {
        list: { getSnapshot: () => ({}) },
        binding: () => undefined,
      },
      setTimeout() { scheduled += 1; return scheduled; },
      clearTimeout() {},
      reload() {},
    });
    assert.equal(scheduled, 0);
    watchdog.dispose();
  });
});
