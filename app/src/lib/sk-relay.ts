export type SkValueCallback = (path: string, value: unknown, timestamp: string) => void;

export interface SkRelay {
  connect(wsUrl: string): void;
  disconnect(): void;
  /** Returns a subscriptionId. */
  subscribe(path: string, cb: SkValueCallback): string;
  unsubscribe(subscriptionId: string): void;
}

// ── SK delta shape (minimal) ──────────────────────────────────────────────────

interface SkValue { path: string; value: unknown; }
interface SkUpdate { timestamp: string; values: SkValue[]; }
interface SkDelta { context?: string; updates?: SkUpdate[]; }

// ── Internal subscription record ──────────────────────────────────────────────

interface SubRecord { path: string; cb: SkValueCallback; }

// ── Reconnect constants ───────────────────────────────────────────────────────

const BACKOFF_INIT_MS = 2_000;
const BACKOFF_MAX_MS  = 30_000;

// ── Factory ───────────────────────────────────────────────────────────────────

export function createSkRelay(): SkRelay {
  // subId → {path, cb}
  const subs = new Map<string, SubRecord>();
  // path → Set<subId>  (for fan-out on incoming delta)
  const pathSubs = new Map<string, Set<string>>();

  let ws: WebSocket | null = null;
  let wsUrl = '';
  let intentionalClose = false;
  let backoffMs = BACKOFF_INIT_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // ── WS helpers ──────────────────────────────────────────────────────────────

  function sendJson(obj: unknown): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function subscribePathUpstream(path: string): void {
    sendJson({
      context: 'vessels.self',
      subscribe: [{ path, period: 1000 }],
    });
  }

  function unsubscribePathUpstream(path: string): void {
    sendJson({
      context: 'vessels.self',
      unsubscribe: [{ path }],
    });
  }

  function resubscribeAll(): void {
    for (const path of pathSubs.keys()) {
      subscribePathUpstream(path);
    }
  }

  // ── Open / close ─────────────────────────────────────────────────────────────

  function openWs(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const url = wsUrl.includes('?') ? `${wsUrl}&subscribe=none` : `${wsUrl}?subscribe=none`;
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      backoffMs = BACKOFF_INIT_MS;
      resubscribeAll();
    });

    ws.addEventListener('message', (ev: MessageEvent<string>) => {
      let delta: SkDelta;
      try { delta = JSON.parse(ev.data) as SkDelta; }
      catch { return; }

      if (!delta.updates) return;

      for (const update of delta.updates) {
        if (!Array.isArray(update.values)) continue;
        const ts = update.timestamp;
        for (const entry of update.values) {
          const ids = pathSubs.get(entry.path);
          if (!ids) continue;
          for (const id of ids) {
            subs.get(id)?.cb(entry.path, entry.value, ts);
          }
        }
      }
    });

    ws.addEventListener('close', () => {
      ws = null;
      if (intentionalClose) return;
      reconnectTimer = setTimeout(() => {
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        openWs();
      }, backoffMs);
    });

    ws.addEventListener('error', () => {
      // 'close' fires after 'error'; reconnect handled there
      ws?.close();
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  function connect(url: string): void {
    intentionalClose = false;
    wsUrl = url;
    openWs();
  }

  function disconnect(): void {
    intentionalClose = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
  }

  function subscribe(path: string, cb: SkValueCallback): string {
    const subId = crypto.randomUUID();
    subs.set(subId, { path, cb });

    const existing = pathSubs.get(path);
    if (existing) {
      existing.add(subId);
    } else {
      pathSubs.set(path, new Set([subId]));
      // First listener for this path — tell the server
      subscribePathUpstream(path);
    }
    return subId;
  }

  function unsubscribe(subId: string): void {
    const record = subs.get(subId);
    if (!record) return;
    subs.delete(subId);

    const ids = pathSubs.get(record.path);
    if (!ids) return;
    ids.delete(subId);
    if (ids.size === 0) {
      pathSubs.delete(record.path);
      // Last listener gone — tell the server
      unsubscribePathUpstream(record.path);
    }
  }

  return { connect, disconnect, subscribe, unsubscribe };
}
