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
  | { type: 'disconnect' };

let client: SignalKClient | null = null;
let wasmReady = false;

async function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    await __wbg_init();
    wasmReady = true;
  }
}

self.onmessage = async (e: MessageEvent<InMessage>): Promise<void> => {
  const msg = e.data;
  if (msg.type === 'connect') {
    await ensureWasm();
    client?.close();
    try {
      client = new SignalKClient(
        msg.url,
        (state: unknown) => { self.postMessage({ type: 'state', state }); },
        (status: number) => { self.postMessage({ type: 'status', status }); },
        (targets: unknown) => { self.postMessage({ type: 'ais', targets }); },
      );
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
  } else {
    client?.close();
    client = null;
  }
};
