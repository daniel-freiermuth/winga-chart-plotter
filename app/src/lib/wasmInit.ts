/**
 * Single shared WASM init for the main thread.
 *
 * `__wbg_init()` is NOT safe to call from more than one module at once: it
 * guards against re-entry by checking the module-scope `wasm` binding, but
 * that binding is only set once the (async) fetch+compile completes. Two
 * independent top-level `__wbg_init()` calls (e.g. one each from
 * `wasmGeo.ts` and `wasmRest.ts`, both racing during app bootstrap) would
 * both see `wasm === undefined`, both instantiate a *separate*
 * `WebAssembly.Instance`, and the second instantiation silently clobbers
 * the first's closures/table state — surfacing as "FnOnce called more than
 * once" panics from whichever Rust closures were mid-flight. Every
 * main-thread wrapper MUST import `ready` from here instead of calling
 * `__wbg_init()` itself. The worker thread initializes its own separate
 * copy independently (see `signalk.worker.ts`) — a WASM instance is
 * per-JS-realm, not shared across the Worker boundary, so that one is fine.
 */
import __wbg_init from '../wasm/signalk_chart_core.js';

export const ready: Promise<unknown> = __wbg_init().catch((err: unknown) => {
  console.error('Failed to initialize WASM module:', err);
  throw err;
});
