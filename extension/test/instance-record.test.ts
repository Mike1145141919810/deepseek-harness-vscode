import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearInstanceRecord,
  loadInstanceRecord,
  pidIsAlive,
  recordPath,
  saveInstanceRecord,
} from '../src/instance-record';

describe('instance-record', () => {
  it('saves, loads, and clears a record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-record-'));
    try {
      const record = {
        v: 1 as const,
        instanceId: 'abc',
        pid: 1234,
        port: 4321,
        startedAt: new Date().toISOString(),
      };
      assert.equal(loadInstanceRecord(dir), undefined);
      saveInstanceRecord(dir, record);
      assert.ok(fs.existsSync(recordPath(dir)));
      assert.deepEqual(loadInstanceRecord(dir), record);
      clearInstanceRecord(dir);
      assert.equal(loadInstanceRecord(dir), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for corrupt or foreign JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-record-corrupt-'));
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(recordPath(dir), '{not json');
      assert.equal(loadInstanceRecord(dir), undefined);
      fs.writeFileSync(recordPath(dir), JSON.stringify({ v: 2, pid: 1, port: 2, startedAt: 'x', instanceId: 'x' }));
      assert.equal(loadInstanceRecord(dir), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pidIsAlive detects live and invalid pids', () => {
    assert.equal(pidIsAlive(process.pid), true);
    assert.equal(pidIsAlive(-1), false);
    assert.equal(pidIsAlive(0), false);
    assert.equal(pidIsAlive(999999999), false);
  });
});
