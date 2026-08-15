import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePortFromStream, parseUrlLine } from '../src/stdout-adapter';

describe('stdout-adapter', () => {
  it('parses the current dsh startup line', () => {
    const parsed = parseUrlLine('dsh web: http://127.0.0.1:3080');
    assert.deepEqual(parsed, { url: 'http://127.0.0.1:3080', host: '127.0.0.1', port: 3080 });
  });

  it('parses the line when a LAN hint follows', () => {
    const parsed = parseUrlLine('dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.7:3080)');
    assert.deepEqual(parsed, { url: 'http://127.0.0.1:3080', host: '127.0.0.1', port: 3080 });
  });

  it('parses a future variant with a different phrasing', () => {
    const parsed = parseUrlLine('dsh web: http://localhost:49152');
    assert.deepEqual(parsed, { url: 'http://localhost:49152', host: 'localhost', port: 49152 });
  });

  it('rejects unrelated lines and invalid ports', () => {
    assert.equal(parseUrlLine('some other log line'), undefined);
    assert.equal(parseUrlLine('dsh web: http://127.0.0.1:0'), undefined);
    assert.equal(parseUrlLine('dsh web: http://127.0.0.1:99999'), undefined);
    assert.equal(parseUrlLine('dsh web started at http://127.0.0.1:1234 (hypothetical)'), undefined);
  });

  it('scans a chunk and returns the last startup port', () => {
    const chunk = [
      'info: composing profile',
      'dsh web: http://127.0.0.1:10001',
      'another line',
      'dsh web: http://127.0.0.1:10002 (LAN: http://192.168.1.7:10002)',
    ].join('\n');
    assert.equal(parsePortFromStream(chunk), 10002);
  });
});
