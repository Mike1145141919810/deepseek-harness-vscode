// Real-browser smoke for the DSH client halves of Phase 2B and Phase 2C.
//
// Loads the running DSH GUI inside a tiny parent frame (the same embedding
// boundary as the VS Code webview), clicks the rendered context button through
// Chrome DevTools Protocol, and waits for SessionFace.command to acknowledge
// the installed /vscode-context Host command. It also imports the installed
// bridge from DSH's live module system, renders the actual produced-files
// React component with a fixed FileDiff, and clicks its read-only diff button.
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
const fixtureDiff = {
  cwd: path.resolve(__dirname, '..'),
  path: 'README.md',
  oldText: '# DeepSeek Harness\n',
  newText: '# DeepSeek Harness for VS Code\n',
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
<html><body data-request="waiting" data-diff="waiting">
<iframe id="dsh" src="${dshUrl}" style="width:1200px;height:800px;border:0"></iframe>
<script>
const frame = document.getElementById('dsh');
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.origin !== ${JSON.stringify(origin)}) return;
  const data = event.data;
  if (!data) return;
  if (data.type === 'dsh:requestEditorContext') {
    document.body.dataset.request = 'received';
    frame.contentWindow.postMessage({
      type: 'dsh:editorContext',
      requestId: data.requestId,
      sessionId: data.sessionId,
      ok: true,
      context: ${JSON.stringify(fixtureContext)}
    }, ${JSON.stringify(origin)});
    return;
  }
  if (data.type === 'dsh:previewDiff') {
    const first = typeof data.file === 'string' ? data.file.charCodeAt(0) : -1;
    const windowsAbsolute = (first >= 65 && first <= 90 || first >= 97 && first <= 122) &&
      data.file[1] === ':' && (data.file[2] === '\\\\' || data.file[2] === '/');
    const valid = typeof data.file === 'string' &&
      (windowsAbsolute || data.file.startsWith('/')) &&
      Array.isArray(data.diffs) &&
      data.diffs.length > 0 &&
      data.diffs.every((diff) => diff &&
        (diff.oldText === null || typeof diff.oldText === 'string') &&
        typeof diff.newText === 'string' &&
        Object.keys(diff).sort().join(',') === 'newText,oldText');
    document.body.dataset.diff = valid ? 'received' : 'invalid';
    window.__dshDiffMessage = data;
  }
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
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const target = await poll(async () => {
      const targets = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
      return targets.find((candidate) => candidate.type === 'page');
    }, 20_000);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        let loaderValue;
        const wrapLoader = (loader) => {
          if (!loader || typeof loader.create !== 'function' || loader.__dshVscodeSmokeWrapped) return;
          const create = loader.create;
          Object.defineProperty(loader, '__dshVscodeSmokeWrapped', { value: true });
          loader.create = function(options) {
            const modules = create.call(this, options);
            window.__dshVscodeSmokeModules = modules;
            return modules;
          };
        };
        Object.defineProperty(window, '__ModuleLoader__', {
          configurable: true,
          get: () => loaderValue,
          set: (value) => {
            loaderValue = value;
            wrapLoader(value);
          },
        });
        document.addEventListener('dsh-vscode-smoke-render-diff', async () => {
          try {
            const modules = window.__dshVscodeSmokeModules;
            if (!modules) throw new Error('DSH client module system was not captured');
            const [bridge, React, ReactDOM] = await Promise.all([
              modules.import('dsh-vscode-bridge'),
              modules.import('react'),
              modules.import('react-dom/client'),
            ]);
            if (typeof bridge.VSCodeOpenButtons !== 'function') {
              throw new Error('installed bridge does not export VSCodeOpenButtons');
            }
            const rootElement = document.createElement('div');
            rootElement.id = 'dsh-vscode-smoke-diff-root';
            document.body.append(rootElement);
            const useSessions = (selector) => selector({
              byId: { smoke: { cwd: ${JSON.stringify(fixtureDiff.cwd)} } },
            });
            const t = (key, values) => values?.name ? key + ': ' + values.name : key;
            ReactDOM.createRoot(rootElement).render(React.createElement(bridge.VSCodeOpenButtons, {
              matched: {
                paths: [${JSON.stringify(fixtureDiff.path)}],
                previews: [{
                  path: ${JSON.stringify(fixtureDiff.path)},
                  diffs: [{
                    oldText: ${JSON.stringify(fixtureDiff.oldText)},
                    newText: ${JSON.stringify(fixtureDiff.newText)},
                  }],
                }],
              },
              openFile: () => {},
              isLoopback: true,
              useHostDescription: (selector) => selector({ canOpenPath: false }),
              useSessions,
              sessionId: 'smoke',
              t,
            }));
          } catch (error) {
            document.documentElement.dataset.dshVscodeSmokeError =
              error instanceof Error ? error.message : String(error);
          }
        });
      })();`,
    });
    await cdp.send('Page.navigate', { url: wrapperUrl });

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

    let button;
    try {
      button = await poll(async () => {
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
    } catch (error) {
      const child = await cdp.send('Runtime.evaluate', {
        contextId: executionContextId,
        expression: `(() => {
          const button = document.querySelector('[data-dsh-vscode-context]');
          return button && {
            state: button.dataset.state,
            text: button.textContent,
            title: button.title,
          };
        })()`,
        returnByValue: true,
      });
      const parent = await cdp.send('Runtime.evaluate', {
        expression: `({
          request: document.body.dataset.request,
          diff: document.body.dataset.diff,
          hasHandler: typeof window.__dshDiffMessage !== 'undefined',
        })`,
        returnByValue: true,
      });
      throw new Error(
        `${error.message}; context button=${JSON.stringify(child.result.value)}; ` +
        `parent=${JSON.stringify(parent.result.value)}`,
      );
    }
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

    await cdp.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression: "document.dispatchEvent(new Event('dsh-vscode-smoke-render-diff'))",
    });
    const hasDiffButton = async () => {
      const result = await cdp.send('Runtime.evaluate', {
        contextId: executionContextId,
        expression: `(() => {
          const error = document.documentElement.dataset.dshVscodeSmokeError;
          return error ? { error } : {
            found: Boolean(document.querySelector('[data-dsh-vscode-diff]')),
          };
        })()`,
        returnByValue: true,
      });
      if (result.result.value?.error) throw new Error(result.result.value.error);
      return result.result.value?.found === true;
    };

    try {
      await poll(async () => {
        return await hasDiffButton() ? true : undefined;
      }, 30_000);
    } catch (error) {
      const diagnostics = await cdp.send('Runtime.evaluate', {
        contextId: executionContextId,
        expression: `({
          text: document.body.innerText.slice(0, 4000),
          buttons: [...document.querySelectorAll('button')].map((button) => ({
            text: button.textContent,
            title: button.title,
            diff: button.hasAttribute('data-dsh-vscode-diff'),
          })).slice(0, 80),
          producedRows: document.querySelectorAll('[data-produced-files-row]').length,
          href: location.href,
        })`,
        returnByValue: true,
      });
      throw new Error(`${error.message}; diff diagnostics=${JSON.stringify(diagnostics.result.value)}`);
    }
    await cdp.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression: "document.querySelector('[data-dsh-vscode-diff]').click()",
    });
    const diffMessage = await poll(async () => {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `document.body.dataset.diff === 'received'
          ? ({
              file: window.__dshDiffMessage.file,
              hunks: window.__dshDiffMessage.diffs.length,
            })
          : document.body.dataset.diff === 'invalid'
            ? ({ invalid: true })
            : undefined`,
        returnByValue: true,
      });
      if (result.result.value?.invalid === true) {
        throw new Error('the DSH client sent an invalid diff-preview payload');
      }
      return result.result.value;
    }, 15_000);
    console.log('GUI_DIFF_BUTTON=clicked');
    console.log('GUI_DIFF_REQUEST=received');
    console.log(`GUI_DIFF_FILE=${diffMessage.file}`);
    console.log(`GUI_DIFF_HUNKS=${diffMessage.hunks}`);
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
