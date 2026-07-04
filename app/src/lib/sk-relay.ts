import { randomUuid } from './uuid';

export type SkValueCallback = (path: string, value: unknown, timestamp: string) => void;

export interface SkRelay {
  /**
   * Feed a raw SK delta JSON string (forwarded from the worker) into the relay.
   * Subscribers are notified for any path they have registered.
   */
  feed(text: string): void;
  /** Returns a subscriptionId. */
  subscribe(path: string, cb: SkValueCallback): string;
  unsubscribe(subscriptionId: string): void;
  /**
   * Re-send upstream subscribe messages for every path that currently has at
   * least one subscriber.  Call this after a WebSocket reconnect so the new
   * server connection learns about all active subscriptions.
   */
  resubscribe(): void;
}

// ── SK delta shape (minimal) ──────────────────────────────────────────────────

interface SkValue { path: string; value: unknown; }
interface SkUpdate { timestamp: string; values: SkValue[]; }
// The Hello message has a `self` field with the own-vessel context string.
interface SkDelta { context?: string; updates?: SkUpdate[]; self?: string; }

// ── Internal subscription record ──────────────────────────────────────────────

interface SubRecord { path: string; cb: SkValueCallback; }

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a relay that fans out SK path/value/timestamp tuples to subscribers.
 *
 * `sendUpstream` is called with raw SK JSON subscribe/unsubscribe messages
 * whenever the first/last subscriber for a path is added/removed.  Pass a
 * function that forwards the string to the SignalK WebSocket (via the worker).
 */
export function createSkRelay(sendUpstream: (msg: string) => void): SkRelay {
  // subId → {path, cb}
  const subs = new Map<string, SubRecord>();
  // path → Set<subId>  (for fan-out on incoming delta)
  const pathSubs = new Map<string, Set<string>>();

  // Own-vessel context string learned from the SK Hello message.
  // Signal K servers resolve "vessels.self" to the actual UUID in delta
  // responses (e.g. "vessels.urn:mrn:signalk:uuid:…"), so we must learn it
  // from the Hello before we can filter correctly.
  let selfContext: string | undefined;

  function subscribePathUpstream(path: string): void {
    sendUpstream(JSON.stringify({
      context: 'vessels.self',
      subscribe: [{ path, period: 1000 }],
    }));
  }

  function unsubscribePathUpstream(path: string): void {
    sendUpstream(JSON.stringify({
      context: 'vessels.self',
      unsubscribe: [{ path }],
    }));
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  function feed(text: string): void {
    let delta: SkDelta;
    try { delta = JSON.parse(text) as SkDelta; }
    catch { return; }

    // Hello message: {"version":"…","self":"vessels.urn:mrn:signalk:uuid:…"}
    // Capture the own-vessel context so we can filter deltas correctly below.
    if (typeof delta.self === 'string' && !delta.updates) {
      selfContext = delta.self;
      return;
    }

    if (!delta.updates) return;

    // Only fan-out own-vessel deltas. AIS deltas arrive with a different
    // context (e.g. "vessels.urn:mrn:imo:mmsi:…") and must not bleed into
    // widget subscriptions that expect self data.
    //
    // Accept when:
    //   • context is absent (rare; some servers omit it for self updates)
    //   • context is the literal alias "vessels.self"
    //   • context matches the actual UUID learned from the Hello message
    if (delta.context !== undefined &&
        delta.context !== 'vessels.self' &&
        delta.context !== selfContext) {
      return;
    }

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
  }

  function subscribe(path: string, cb: SkValueCallback): string {
    const subId = randomUuid();
    subs.set(subId, { path, cb });

    const existing = pathSubs.get(path);
    if (existing) {
      existing.add(subId);
    } else {
      pathSubs.set(path, new Set([subId]));
      // First listener for this path — tell the server via the worker.
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
      // Last listener gone — tell the server via the worker.
      unsubscribePathUpstream(record.path);
    }
  }

  function resubscribe(): void {
    for (const path of pathSubs.keys()) {
      subscribePathUpstream(path);
    }
  }

  return { feed, subscribe, unsubscribe, resubscribe };
}
