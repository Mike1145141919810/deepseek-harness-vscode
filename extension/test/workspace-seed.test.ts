import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { seedWorkspace } from '../src/workspace-seed';

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('workspace-seed rpc retry', () => {
  it('retries an HTTP 404 (apiProxy boot race) and succeeds', async () => {
    let calls = 0;
    const srv = await startServer((req, res, body) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const request = JSON.parse(body) as { rpcId: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          rpcId: request.rpcId,
          result: { ok: true, value: { workspace: { workspaceId: 'w-1' }, created: true } },
        }),
      );
    });
    try {
      const outcome = await seedWorkspace(srv.baseUrl, 'C:/tmp/some-folder');
      assert.equal(outcome.ok, true, outcome.detail);
      assert.equal(outcome.workspaceId, 'w-1');
      assert.equal(outcome.created, true);
      assert.equal(calls, 2, 'one 404 then one success');
    } finally {
      await srv.close();
    }
  });

  it('does not retry a well-formed RPC-level error', async () => {
    let calls = 0;
    const srv = await startServer((req, res, body) => {
      calls += 1;
      const request = JSON.parse(body) as { rpcId: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          rpcId: request.rpcId,
          result: { ok: false, error: { message: 'workspace path rejected' } },
        }),
      );
    });
    try {
      const outcome = await seedWorkspace(srv.baseUrl, 'C:/tmp/other-folder');
      assert.equal(outcome.ok, false);
      assert.equal(outcome.detail, 'workspace path rejected');
      assert.equal(calls, 1, 'application-level errors must not retry');
    } finally {
      await srv.close();
    }
  });
});
