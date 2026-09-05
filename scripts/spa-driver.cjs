/*
 * Drive the DSH SPA in real Chromium (Edge headless) via CDP over WebSocket,
 * no external dependencies (Node >= 22 has WebSocket).
 *
 * Handoff 对照 A: plain-browser test. Boot the SPA in a FRESH profile, prompt
 * the session the SPA itself displays (localStorage dsh.sessions.current),
 * then watch BOTH the DOM and the page's own WebSocket traffic. If the page
 * receives turn/end + host/session-status running:false but the UI still
 * shows "Deep diving..." / a stuck queue bubble, the bug lives in the DSH
 * client itself, not in VS Code.
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const EDGE = process.env.EDGE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DSH_URL = process.argv[2] ?? 'http://127.0.0.1:53587';

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spa-'));
const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

const t0 = Date.now();
const log = (...args) => console.log(`[+${String(Date.now() - t0).padStart(7)}ms]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

let nextId = 0;
const pending = new Map();

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.wsByRequest = new Map();
    this.frameCounts = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method === 'Network.webSocketCreated') {
        this.wsByRequest.set(message.params.requestId, message.params.url);
        log('ws open:', String(message.params.url).split('/api/')[1] ?? message.params.url);
      } else if (message.method === 'Network.webSocketClosed') {
        const url = this.wsByRequest.get(message.params.requestId) ?? '?';
        log('ws closed:', String(url).split('/api/')[1] ?? url);
      } else if (message.method === 'Network.webSocketFrameReceived') {
        const url = this.wsByRequest.get(message.params.requestId) ?? '?';
        const short = url.includes('/api/') ? url.split('/api/')[1] : url;
        let frame;
        try { frame = JSON.parse(message.params.response.payloadData); } catch { return; }
        const p = frame.payload ?? {};
        let summary;
        if (p.type === 'session/event') summary = `${p.event?.type}#${p.event?.seq}`;
        else if (p.type === 'host/session-status') summary = `running=${p.running}`;
        else if (p.type === 'session/subscribed') summary = `lastSeq=${p.lastSeq}`;
        else if (p.type === 'session/queue') summary = `queue[${(p.items ?? []).map((i) => i.placement).join(',')}]`;
        else summary = p.type ?? 'unknown';
        const countKey = `${short} :: ${summary}`;
        this.frameCounts.set(countKey, (this.frameCounts.get(countKey) ?? 0) + 1);
        log('wsrx', short, summary, p.sessionId ? `sid=${String(p.sessionId).slice(0, 8)}` : '');
      } else if (message.method === 'Runtime.consoleAPICalled') {
        const args = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
        log(`console[${message.params.type}]`, args.slice(0, 200));
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        log('exception:', (details.exception?.description ?? details.text ?? '?').slice(0, 400));
      } else if (message.method === 'Log.entryAdded') {
        const entry = message.params.entry;
        if (entry.level === 'error' || entry.level === 'warning') {
          log(`page ${entry.level}:`, entry.text.slice(0, 200));
        }
      }
    });
  }
  send(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      return { exception: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed' };
    }
    return { value: result.result?.value };
  }
}

async function main() {
  // 1. Find the DevTools port.
  let port;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const lines = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
      port = Number(lines[0]);
      if (port > 0) break;
    } catch {}
    await sleep(250);
  }
  if (!port) throw new Error('Edge DevToolsActivePort never appeared');
  log('devtools port =', port);

  // 2. Find the page target and connect.
  let targets = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    try { targets = await getJson(`http://127.0.0.1:${port}/json/list`); } catch {}
    if (targets.length > 0) break;
    await sleep(250);
  }
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('no page target');
  const cdp = await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.addEventListener('open', () => resolve(new Cdp(ws)));
    ws.addEventListener('error', () => reject(new Error('cdp connect failed')));
  });

  // 3. Enable domains BEFORE navigation so page WebSockets are captured.
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.navigate', { url: DSH_URL });
  log('navigated to', DSH_URL);

  // 4. Wait for the SPA to boot.
  let booted = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await cdp.eval(`(() => {
      const composer = document.querySelector('textarea, [contenteditable="true"], [data-composer-seat], form');
      return { hasComposer: composer !== null, text: (document.body?.innerText ?? '').slice(0, 200), ready: document.readyState };
    })()`);
    if (state.exception) { log('boot eval exception:', state.exception); }
    if (state.value?.hasComposer && state.value.text.length > 0) { booted = true; break; }
    await sleep(400);
  }
  if (!booted) throw new Error('SPA boot timeout');
  log('SPA booted');

  // 5. Which session does the SPA display? (fresh profile: persisted/auto-selected)
  const selected = await cdp.eval(`(() => {
    const raw = localStorage.getItem('dsh.sessions.current');
    let parsed = raw;
    try { parsed = JSON.parse(raw); } catch {}
    return { raw, parsed, keys: Object.keys(localStorage).sort() };
  })()`);
  log('dsh.sessions.current =', JSON.stringify(selected.value?.parsed ?? selected.value?.raw));
  log('localStorage keys =', JSON.stringify(selected.value?.keys));
  const targetSessionId = selected.value?.parsed?.sessionId;
  if (!targetSessionId) throw new Error('no current session in localStorage');

  // 5b. Start counting notifier fires on the displayed session (bridge diag).
  await cdp.eval(`window.__DSH_DIAG__?.watchFires(${JSON.stringify(targetSessionId)}); true`);

  // 6. Prompt the SAME session the UI is displaying, via the page's own fetch.
  const prompted = await cdp.eval(`(async () => {
    const rpcId = crypto.randomUUID();
    const response = await fetch('/api/session.prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'session.prompt', payload: {
        sessionId: ${JSON.stringify(targetSessionId)},
        mode: 'queue',
        content: [{ type: 'text', text: '你好，请只回复 pong 两个字' }],
        clientTimeZone: 'Asia/Shanghai',
      }}),
    });
    return response.json();
  })()`);
  log('prompt result =', JSON.stringify(prompted.value).slice(0, 200));

  // 7. Watch the DOM while the turn runs.
  let finalDom = null;
  let outcome = 'timeout';
  for (let attempt = 0; attempt < 60; attempt++) {
    const dom = await cdp.eval(`(() => {
      const text = document.body?.innerText ?? '';
      return {
        spinner: text.includes('Deep diving'),
        hasPong: text.includes('pong'),
        tail: text.slice(-260),
      };
    })()`);
    finalDom = dom.value ?? {};
    log('dom watch', JSON.stringify({ spinner: finalDom.spinner, hasPong: finalDom.hasPong }));
    if (finalDom.hasPong && !finalDom.spinner) { outcome = 'rendered'; break; }
    await sleep(1000);
  }
  log('OUTCOME:', outcome);

  // 7b. Does requestAnimationFrame tick in this page? (frame-scheduled flushes)
  //     Race a hard wall-clock cap: if rAF never fires the promise alone hangs.
  const raf = await cdp.eval(`(async () => {
    const started = Date.now();
    let n = 0;
    const counting = new Promise((resolve) => {
      const tick = () => {
        if (Date.now() - started > 3000) { resolve(n); return; }
        n += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const capped = new Promise((resolve) => setTimeout(() => resolve(-1), 3500));
    const ticks = await Promise.race([counting, capped]);
    return { ticks, vis: document.visibilityState };
  })()`);
  log('raf probe =', JSON.stringify(raf.value));

  // 8. Authoritative server view + page WS traffic summary.
  const serverState = await cdp.eval(`(async () => {
    const post = async (method, payload) => {
      const rpcId = crypto.randomUUID();
      const response = await fetch('/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      });
      return response.json();
    };
    const list = await post('session.list', {});
    const history = await post('session.history', { sessionId: ${JSON.stringify(targetSessionId)}, maxMessages: 50 });
    const item = list.result?.value?.items?.find((entry) => entry.sessionId === ${JSON.stringify(targetSessionId)});
    const types = history.result?.value?.events?.map((entry) => entry.event.type) ?? [];
    return { running: item?.running, eventTypes: types };
  })()`);
  log('authoritative =', JSON.stringify(serverState.value).slice(0, 400));

  // 8b. In-page diagnostics: bridge view of the session + the stuck DOM element.
  const diag = await cdp.eval(`(() => {
    const out = {};
    out.hasDiag = typeof window.__DSH_DIAG__;
    out.fires = window.__DSH_DIAG_FIRES__ ?? null;
    if (window.__DSH_DIAG__) {
      try { out.session = window.__DSH_DIAG__.dumpSession(${JSON.stringify(targetSessionId)}); } catch (e) { out.sessionErr = String(e); }
      try { out.list = window.__DSH_DIAG__.list(); } catch (e) { out.listErr = String(e); }
      try { out.bindings = window.__DSH_DIAG__.bindings(); } catch (e) { out.bindingsErr = String(e); }
    }
    out.reactHook = typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const els = [...document.querySelectorAll('*')].filter(el => el.children.length === 0 && (el.textContent ?? '').includes('Deep diving'));
    out.spinnerEls = els.map(el => {
      const chain = [];
      let p = el;
      for (let i = 0; i < 5 && p; i++) { p = p.parentElement; if (p) chain.push(typeof p.className === 'string' ? p.className.slice(0, 90) : p.tagName); }
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { text: el.textContent.slice(0, 40), cls: String(el.className).slice(0, 90), chain, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, display: style.display, visibility: style.visibility };
    });
    return out;
  })()`);
  log('DIAG =', JSON.stringify(diag.value).slice(0, 1800));
  log('ws frame counts:');
  for (const [key, count] of cdp.frameCounts) log('  ', count, 'x', key);

  await sleep(1000);
  process.exit(0);
}

main().catch((error) => {
  log('FATAL', String(error));
  process.exit(1);
});
