// Real-browser smoke for the DSH client half of Phase 2B.
//
// Loads the running DSH GUI inside a tiny parent frame (the same embedding
// boundary as the VS Code webview), clicks the rendered context button through
// Chrome DevTools Protocol, and waits for SessionFace.command to acknowledge
// the installed /vscode-context Host command.
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const dshUrl = process.argv[2];
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(dshUrl ?? '')) {
  console.error('usage: node test/gui-bridge-smoke.js http://127.0.0.1:<port>');
  process.exit(2);
}
if (typeof WebSocket !== 'function') {
  console.error('This smoke test requires a Node runtime with global WebSocket support.');
  process.exit(2);
}

const edgeCandidates = [
  process.env.EDGE_EXE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const edgePath = edgeCandidates.find((candidate) => fs.existsSync(candidate));
if (edgePath === undefined) {
  console.error('Microsoft Edge not found; set EDGE_EXE to a Chromium executable.');
  process.exit(2);
}

const fixtureContext = {
  version: 1,
  file: path.resolve(__dirname, '..', 'README.md'),
  uri: new URL(`file:///${path.resolve(__dirname, '..', 'README.md').replace(/\\/g, '/')}`).toString(),
  languageId: 'markdown',
  documentVersion: 1,
  isDirty: false,
  cursor: { line: 1, character: 1 },
  selection: {
    start: { line: 1, character: 1 },
    end: { line: 1, character: 6 },
    text: 'Phase',
    truncated: false,
  },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTemporaryDirectory(directory) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) {
        console.warn(`temporary Edge profile cleanup deferred: ${error.message}`);
        return;
      }
      await delay(200);
    }
  }
}

async function poll(probe, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  if (lastError !== undefined) throw lastError;
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`${url} returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
  });
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

function childFrames(frameTree) {
  return [
    frameTree.frame,
    ...(frameTree.childFrames ?? []).flatMap((child) => childFrames(child)),
  ];
}

async function main() {
  const wrapperPort = await freePort();
  const debugPort = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gui-smoke-'));
  const origin = new URL(dshUrl).origin;
  const html = `<!doctype html>
<html><body data-request="waiting">
<iframe id="dsh" src="${dshUrl}" style="width:1200px;height:800px;border:0"></iframe>
<script>
const frame = document.getElementById('dsh');
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.origin !== ${JSON.stringify(origin)}) return;
  const data = event.data;
  if (!data || data.type !== 'dsh:requestEditorContext') return;
  document.body.dataset.request = 'received';
  frame.contentWindow.postMessage({
    type: 'dsh:editorContext',
    requestId: data.requestId,
    sessionId: data.sessionId,
    ok: true,
    context: ${JSON.stringify(fixtureContext)}
  }, ${JSON.stringify(origin)});
});
</script></body></html>`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wrapperPort, '127.0.0.1', resolve);
  });

  const wrapperUrl = `http://127.0.0.1:${wrapperPort}/`;
  const edge = cp.spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    wrapperUrl,
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const target = await poll(async () => {
      const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
      return targets.find((candidate) => candidate.type === 'page' && candidate.url === wrapperUrl);
    }, 20_000);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const frameId = await poll(async () => {
      const { frameTree } = await cdp.send('Page.getFrameTree');
      return childFrames(frameTree).find((frame) => frame.url.startsWith(dshUrl))?.id;
    }, 20_000);
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId,
      worldName: 'dsh-vscode-gui-smoke',
      grantUniversalAccess: true,
    });

    try {
      await poll(async () => {
        const result = await cdp.send('Runtime.evaluate', {
          contextId: executionContextId,
          expression: "Boolean(document.querySelector('[data-dsh-vscode-context]'))",
          returnByValue: true,
        });
        return result.result.value === true ? true : undefined;
      }, 30_000);
    } catch (error) {
      const diagnostics = await cdp.send('Runtime.evaluate', {
        contextId: executionContextId,
        expression: `({
          title: document.title,
          text: document.body.innerText.slice(0, 2000),
          buttons: [...document.querySelectorAll('button')].map((button) => button.textContent).slice(0, 30),
        })`,
        returnByValue: true,
      });
      throw new Error(`${error.message}; GUI diagnostics=${JSON.stringify(diagnostics.result.value)}`);
    }
    await cdp.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression: "document.querySelector('[data-dsh-vscode-context]').click()",
    });

    const button = await poll(async () => {
      const result = await cdp.send('Runtime.evaluate', {
        contextId: executionContextId,
        expression: `(() => {
          const button = document.querySelector('[data-dsh-vscode-context]');
          return button && button.dataset.state === 'success'
            ? { state: button.dataset.state, text: button.textContent }
            : undefined;
        })()`,
        returnByValue: true,
      });
      return result.result.value;
    }, 15_000);
    const parentResult = await cdp.send('Runtime.evaluate', {
      expression: 'document.body.dataset.request',
      returnByValue: true,
    });
    if (parentResult.result.value !== 'received') {
      throw new Error('the rendered button did not request editor context from its parent');
    }
    console.log(`GUI_BUTTON_STATE=${button.state}`);
    console.log(`GUI_BUTTON_TEXT=${button.text}`);
    console.log('GUI_CONTEXT_REQUEST=received');
    console.log('GUI_SESSION_COMMAND=matched');
  } finally {
    cdp?.close();
    await new Promise((resolve) => server.close(resolve));
    if (edge.pid !== undefined) {
      if (process.platform === 'win32') {
        cp.spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        edge.kill('SIGKILL');
      }
    }
    await removeTemporaryDirectory(profileDir);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
