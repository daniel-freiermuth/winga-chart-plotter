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
  | { type: 'send'; msg: string };

// AIS payload from WASM — hot data as ArrayBuffer + parallel metadata arrays.
interface AisWasmPayload {
  hot: ArrayBuffer;
  ids: string[];
  cold: { id: string; name?: string; mmsi?: string }[];
}

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
    try {
      if (client) {
        // Reuse the existing client — reconnect replaces only the WebSocket while
        // keeping the accumulated Storage intact, so vessel data survives the drop.
        client.reconnect(msg.url);
      } else {
        client = new SignalKClient(
          msg.url,
          (state: unknown) => { self.postMessage({ type: 'state', state }); },
          (status: number) => { self.postMessage({ type: 'status', status }); },
          (payload: AisWasmPayload) => {
            // Transfer the hot ArrayBuffer — zero-copy handoff to main thread.
            self.postMessage(
              { type: 'ais', hot: payload.hot, ids: payload.ids, cold: payload.cold },
              [payload.hot],
            );
          },
          (text: string) => { self.postMessage({ type: 'raw', text }); },
        );
      }
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
  } else if (msg.type === 'send') {
    client?.send(msg.msg);
  } else {
    client?.close();
    client = null;
  }
};
