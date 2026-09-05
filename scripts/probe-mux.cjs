/* Probe DSH server: dump initial frames a fresh mux+host connection receives. */
const BASE = process.argv[2] ?? 'ws://127.0.0.1:53587';

function watch(path, label) {
  const ws = new WebSocket(`${BASE}${path}`);
  let count = 0;
  ws.addEventListener('open', () => {
    console.log(`[${label}] connected`);
  });
  ws.addEventListener('message', (event) => {
    count += 1;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      console.log(`[${label}] non-json message: ${event.data}`);
      return;
    }
    const payload = frame.payload ?? {};
    const summary = {
      type: payload.type,
      sessionId: payload.sessionId,
      lastSeq: payload.lastSeq,
      running: payload.running,
      blank: payload.blank,
      eventType: payload.event?.type,
      eventSeq: payload.event?.seq,
      queueItems: Array.isArray(payload.items) ? payload.items.map((item) => ({ id: item.id, placement: item.placement, messageId: item.message?.id })) : undefined,
      value: payload.value,
    };
    console.log(`[${label}] #${count} ${JSON.stringify(summary)}`);
    if (count >= 40) {
      console.log(`[${label}] closing after ${count} frames`);
      ws.close();
    }
  });
  ws.addEventListener('close', () => console.log(`[${label}] closed`));
  ws.addEventListener('error', (error) => console.log(`[${label}] error: ${String(error?.message ?? error)}`));
}

watch('/api/events.mux', 'mux');
watch('/api/events.host', 'host');
setTimeout(() => process.exit(0), 8000);
