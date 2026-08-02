/**
 * Shared localStorage plumbing for pane-scoped stores.
 *
 * Storage failures (private browsing, quota, disabled storage) are swallowed —
 * the in-memory store state stays authoritative and the app keeps working
 * without persistence. Validation of the parsed value stays with each store;
 * this module only owns the try/catch + JSON boilerplate.
 */

/** Parsed JSON for `key`; null on first run, corrupt data, or unavailable storage. */
export function loadJSON(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    if (s !== null) return JSON.parse(s) as unknown;
  } catch { /* ignore */ }
  return null;
}

/** Persists `value` as JSON under `key`; storage failures are ignored. */
export function saveJSON(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

/** Removes the value persisted under `key`; storage failures are ignored. */
export function removeItem(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
