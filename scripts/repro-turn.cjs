/*
 * Live repro harness: mimic the SPA's wire behavior against the running DSH
 * server — open mux+host streams, create a session, send "你好", and log every
 * frame with arrival timestamps. Compare against what the VS Code sidebar shows.
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:53587';
const CWD = process.argv[3] ?? 'D:\\michael_codes\\dsh-vscode';

const t0 = Date.now();
const log = (...args) => console.log(`[+${String(Date.now() - t0).padStart(6)}ms]`, ...args);

function post(method, payload) {
  const rpcId = crypto.randomUUID();
  return fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  }).then(async (response) => {
    const envelope = await response.json();
    log('rpc', method, `http=${response.status}`, JSON.stringify(envelope.result ?? envelope).slice(0, 400));
    return envelope;
  });
}

function watch(path, label) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}${path}`);
  ws.addEventListener('open', () => log(label, 'connected'));
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    const payload = frame.payload ?? {};
    const summary = {
      type: payload.type,
      sessionId: payload.sessionId,
      lastSeq: payload.lastSeq,
      running: payload.running,
      eventType: payload.event?.type,
      eventSeq: payload.event?.seq,
      eventData: payload.event ? JSON.stringify(payload.event.data).slice(0, 120) : undefined,
      queueItems: Array.isArray(payload.items) ? payload.items.map((item) => ({ id: item.id, placement: item.placement, messageId: item.message?.id })) : undefined,
      viewKeys: payload.view ? Object.keys(payload.view) : undefined,
    };
    log(label, JSON.stringify(summary));
  });
  ws.addEventListener('close', () => log(label, 'closed'));
  ws.addEventListener('error', (error) => log(label, 'error', String(error?.message ?? error)));
}

async function main() {
  watch('/api/events.mux', 'mux');
  watch('/api/events.host', 'host');
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const created = await post('session.create', { cwd: CWD });
  const sessionId = created?.result?.value?.sessionId;
  if (!sessionId) {
    log('FATAL: could not create session; aborting before prompting');
    process.exit(1);
  }
  log('sessionId =', sessionId);

  await new Promise((resolve) => setTimeout(resolve, 1000));
  await post('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '你好' }],
    clientTimeZone: 'Asia/Shanghai',
  });

  // Watch the turn run to completion, then dump final authoritative state.
  await new Promise((resolve) => setTimeout(resolve, 45000));
  await post('session.list', {});
  await post('session.history', { sessionId, maxMessages: 50 });
  process.exit(0);
}

main().catch((error) => {
  log('FATAL', String(error));
  process.exit(1);
});
