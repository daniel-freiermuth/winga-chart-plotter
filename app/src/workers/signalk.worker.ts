/// <reference lib="webworker" />
//
// SignalK Web Worker — runs the WASM SignalKClient off the main thread.
//
// The initial SignalK state burst sends n_vessels × n_paths WebSocket messages
// in rapid succession. Processing each in Rust + serialising with
// serde_wasm_bindgen is O(n) per message (O(n²) total), which would stall
// tile-image decode callbacks on the main thread. Running the client here
// removes that contention entirely: the worker can be busy all it wants and
// the main thread stays free for tile loading.

import __wbg_init, { SignalKClient } from '../wasm/signalk_chart_core.js';

type InMessage =
  | { type: 'connect'; url: string }
  | { type: 'disconnect' }
  | { type: 'send'; msg: string }
  | { type: 'pause' }   // tab went to background — hold updates
  | { type: 'resume' }; // tab came to foreground — flush buffered updates

// AIS payload from WASM — hot data as ArrayBuffer + parallel metadata arrays.
interface AisWasmPayload {
  hot: ArrayBuffer;
  ids: string[];
  cold: { id: string; name?: string; mmsi?: string; skCpa?: { distanceM: number; timeToS: number } | null }[];
}

let client: SignalKClient | null = null;
let wasmReady = false;

// ── Pause / resume ────────────────────────────────────────────────────────────
//
// Browsers throttle the main thread (to ~1 Hz) when the tab is hidden.  The
// worker keeps running unthrottled, so postMessage calls pile up in the main
// thread's event queue.  When the tab regains focus the queue drains at full
// speed, producing a "timelapse" of all intermediate states.
//
// Fix: while paused, buffer only the *latest* state and AIS snapshot; discard
// intermediate ones.  Raw SK deltas (for extension widget subscriptions) are
// dropped entirely — extensions don't need historical replay, and they resume
// getting fresh deltas within their subscription period anyway.  Status events
// (connect / disconnect) always go through so the reconnect logic keeps working.

let paused = false;
let pendingState: unknown = null;
let pendingAis: { hot: ArrayBuffer; ids: string[]; cold: AisWasmPayload['cold'] } | null = null;

function onState(state: unknown): void {
  if (paused) { pendingState = state; return; }
  self.postMessage({ type: 'state', state });
}

function onStatus(status: number): void {
  // Always deliver — connection state must stay accurate while tab is hidden.
  self.postMessage({ type: 'status', status });
}

function onAis(payload: AisWasmPayload): void {
  if (paused) {
    // Overwrite; the old buffer is no longer referenced and will be GC'd.
    pendingAis = { hot: payload.hot, ids: payload.ids, cold: payload.cold };
    return;
  }
  // Transfer the hot ArrayBuffer — zero-copy handoff to main thread.
  self.postMessage(
    { type: 'ais', hot: payload.hot, ids: payload.ids, cold: payload.cold },
    [payload.hot],
  );
}

function onRaw(text: string): void {
  if (paused) return;
  self.postMessage({ type: 'raw', text });
}

function flushPending(): void {
  if (pendingState !== null) {
    self.postMessage({ type: 'state', state: pendingState });
    pendingState = null;
  }
  if (pendingAis !== null) {
    self.postMessage(
      { type: 'ais', hot: pendingAis.hot, ids: pendingAis.ids, cold: pendingAis.cold },
      [pendingAis.hot],
    );
    pendingAis = null;
  }
}

// ── WASM init ─────────────────────────────────────────────────────────────────

async function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    await __wbg_init();
    wasmReady = true;
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<InMessage>): Promise<void> => {
  const msg = e.data;
  if (msg.type === 'connect') {
    await ensureWasm();
    try {
      if (client) {
        // Reuse the existing client — reconnect replaces only the WebSocket while
        // keeping the accumulated Storage intact, so vessel data survives the drop.
        client.reconnect(msg.url);
      } else {
        client = new SignalKClient(msg.url, onState, onStatus, onAis, onRaw);
      }
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
  } else if (msg.type === 'send') {
    client?.send(msg.msg);
  } else if (msg.type === 'pause') {
    paused = true;
  } else if (msg.type === 'resume') {
    paused = false;
    flushPending();
  } else {
    // 'disconnect'
    client?.close();
    client = null;
  }
};
