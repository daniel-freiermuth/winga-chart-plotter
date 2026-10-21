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
   * least one subscriber.  Call this whenever a WebSocket connection opens so
   * the new server connection learns about all active subscriptions; it also
   * resets which paths count as already streamed.
   */
  resubscribe(): void;
}

// ── SK delta shape (minimal) ──────────────────────────────────────────────────

interface SkValue { path: string; value: unknown; }
interface SkUpdate { timestamp: string; values: SkValue[]; }
interface SkDelta { context?: string; updates?: SkUpdate[]; }

// ── Internal subscription record ──────────────────────────────────────────────

interface SubRecord { path: string; cb: SkValueCallback; }

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a relay that fans out SK path/value/timestamp tuples to subscribers.
 *
 * `sendUpstream` is called with a raw SK JSON subscribe message whenever the
 * first subscriber for a path not yet streamed on the current connection is
 * added.  Pass a function that forwards the string to the SignalK WebSocket
 * (via the worker).
 *
 * Releasing the last subscriber sends nothing upstream: Signal K servers only
 * accept unsubscribe-all (`{"context":"*","unsubscribe":[{"path":"*"}]}`) and
 * close the stream on any other unsubscribe, and unsubscribe-all would also
 * cancel the app's own subscriptions on the shared socket.  The server keeps
 * streaming the path until the next reconnect; `feed` drops it.
 */
export function createSkRelay(sendUpstream: (msg: string) => void): SkRelay {
  // subId → {path, cb}
  const subs = new Map<string, SubRecord>();
  // path → Set<subId>  (for fan-out on incoming delta)
  const pathSubs = new Map<string, Set<string>>();
  // Paths subscribed on the current connection.  Never sent twice: the server
  // stacks repeated subscribes and would deliver every value once per copy.
  const streamed = new Set<string>();

  // ── Upstream helpers ─────────────────────────────────────────────────────────

  function subscribePathUpstream(path: string): void {
    streamed.add(path);
    sendUpstream(JSON.stringify({
      context: 'vessels.self',
      subscribe: [{ path, period: 1000 }],
    }));
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  function feed(text: string): void {
    let delta: SkDelta;
    try { delta = JSON.parse(text) as SkDelta; }
    catch { return; }

    if (!delta.updates) return;

    for (const update of delta.updates) {
      if (!Array.isArray(update.values)) continue;
      const ts = update.timestamp;
      for (const entry of update.values) {
        const ids = pathSubs.get(entry.path);
        if (!ids) continue;
        // Snapshot: a callback may subscribe or unsubscribe (e.g. a widget
        // being torn down mid-delta) while we are fanning out.
        for (const id of [...ids]) {
          try {
            subs.get(id)?.cb(entry.path, entry.value, ts);
          } catch (err) {
            // One widget's failure must not cost every later subscriber its
            // update — posting into a frame that is being destroyed throws.
            console.warn('[sk-relay] subscriber threw for', entry.path, err);
          }
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
      // First listener for this path — tell the server via the worker,
      // unless it is still streaming the path for an earlier listener.
      if (!streamed.has(path)) subscribePathUpstream(path);
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
    if (ids.size === 0) pathSubs.delete(record.path);
  }

  function resubscribe(): void {
    // A new connection streams nothing yet.
    streamed.clear();
    for (const path of pathSubs.keys()) {
      subscribePathUpstream(path);
    }
  }

  return { feed, subscribe, unsubscribe, resubscribe };
}
