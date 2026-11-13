import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createSkRelay, type SkSelfValue } from '../lib/sk-relay';

/**
 * What extension widgets receive is decided at the JS↔WASM boundary: the WASM
 * `SignalKClient` serializes each own-vessel delta's accepted entries
 * (`post_self_values` in `client.rs`) and the worker forwards them as a
 * `'delta'` message, which `App.svelte` hands to `relay.feed`. These tests run
 * that path for real — the built WASM module, the real worker module — with
 * only the WebSocket and the worker global faked, so they pin the shape JS
 * actually gets, not the Rust-side model of it.
 */

const SELF = 'vessels.urn:mrn:signalk:uuid:self';
const HELLO = JSON.stringify({ name: 'test', version: '2.0.0', self: SELF });

/** Minimal stand-in for the browser WebSocket the WASM client opens. */
class FakeWebSocket {
  static latest: FakeWebSocket | null = null;
  onopen: ((e: object) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: object) => void) | null = null;
  onclose: ((e: object) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.latest = this;
  }

  send(): void { /* subscribe messages are not under test */ }
  close(): void { /* nothing to tear down */ }

  /** Deliver one server text frame. */
  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
}

interface DeltaMessage { type: 'delta'; values: SkSelfValue[] }

let wasmModule: WebAssembly.Module;
let postMessage: Mock<(message: unknown) => void>;
let send: (data: object) => Promise<void>;

beforeAll(() => {
  // Compiled once; each test instantiates it afresh with a fresh worker module.
  wasmModule = new WebAssembly.Module(
    readFileSync(new URL('../wasm/signalk_chart_core_bg.wasm', import.meta.url)),
  );
});

beforeEach(async () => {
  // Dynamic imports on purpose: the worker module installs `self.onmessage`
  // when it loads, so it must load after `self` is stubbed, fresh per test
  // (`resetModules`) — and the glue must be that same fresh instance, which a
  // static import of `initSync` would not be.
  vi.resetModules();
  // The worker's own `__wbg_init()` returns early once the module-level
  // instance exists, so it never tries to fetch the .wasm in Node.
  const { initSync } = await import('../wasm/signalk_chart_core.js');
  initSync({ module: wasmModule });

  postMessage = vi.fn<(message: unknown) => void>();
  const workerSelf: { postMessage: typeof postMessage; onmessage: ((e: { data: object }) => Promise<void>) | null } =
    { postMessage, onmessage: null };
  vi.stubGlobal('self', workerSelf);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  FakeWebSocket.latest = null;
  await import('./signalk.worker');
  send = async (data) => {
    if (!workerSelf.onmessage) throw new Error('worker did not install onmessage');
    await workerSelf.onmessage({ data });
  };

  await send({ type: 'connect', url: 'ws://boat.test/signalk/v1/stream', serverGen: 1 });
  socket().onopen?.({});
  socket().receive(HELLO);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function socket(): FakeWebSocket {
  if (!FakeWebSocket.latest) throw new Error('the WASM client opened no WebSocket');
  return FakeWebSocket.latest;
}

function deltaMessages(): DeltaMessage[] {
  return postMessage.mock.calls
    .map(([message]) => message as { type: string })
    .filter((message): message is DeltaMessage => message.type === 'delta');
}

describe('signalk worker → relay boundary (real WASM)', () => {
  it('posts one delta message per own-vessel delta, with plain objects and null for a missing timestamp', () => {
    socket().receive({
      context: SELF,
      updates: [
        null,
        {
          timestamp: 'T1',
          values: [
            null,
            { path: 'navigation.x', value: 1 },
            { path: 'navigation.position', value: { longitude: 10, latitude: 59, extra: [1, null] } },
          ],
        },
      ],
    });
    // No context: still own-vessel data for the relay.
    socket().receive({ updates: [{ values: [{ path: 'navigation.y', value: 3 }] }] });

    const messages = deltaMessages();
    expect(messages).toEqual([
      {
        type: 'delta',
        values: [
          { path: 'navigation.x', value: 1, timestamp: 'T1' },
          { path: 'navigation.position', value: { longitude: 10, latitude: 59, extra: [1, null] }, timestamp: 'T1' },
        ],
      },
      { type: 'delta', values: [{ path: 'navigation.y', value: 3, timestamp: null }] },
    ]);
    // Widgets get ordinary JSON-like data: plain objects (not Maps) in the
    // server's key order, real arrays.
    const position = messages[0]?.values[1]?.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(position)).toBe(Object.prototype);
    expect(Object.keys(position)).toEqual(['longitude', 'latitude', 'extra']);
    expect(Array.isArray(position['extra'])).toBe(true);
  });

  it('posts nothing for a Hello, another vessel, or a delta without a well-formed own entry', () => {
    socket().receive(HELLO);
    socket().receive({
      context: 'vessels.urn:mrn:imo:mmsi:230000001',
      updates: [{ values: [{ path: 'navigation.speedOverGround', value: 4 }] }],
    });
    socket().receive({ context: SELF, updates: { values: [{ path: 'navigation.x', value: 1 }] } });
    socket().receive({ context: SELF, updates: [{ values: [null, { value: 2 }] }] });
    socket().receive('not json');

    expect(deltaMessages()).toEqual([]);
  });

  it('rounds integers beyond Number.MAX_SAFE_INTEGER as JSON.parse does instead of dropping the entry', () => {
    socket().receive(
      `{"context":"${SELF}","updates":[{"values":[` +
        '{"path":"a","value":{"ok":1,"n":[9007199254740993,-9007199254740993]}},' +
        '{"path":"b","value":2}]}]}',
    );

    expect(deltaMessages()).toEqual([
      {
        type: 'delta',
        values: [
          {
            path: 'a',
            value: { ok: 1, n: [JSON.parse('9007199254740993'), JSON.parse('-9007199254740993')] },
            timestamp: null,
          },
          { path: 'b', value: 2, timestamp: null },
        ],
      },
    ]);
  });

  it('drops own-vessel deltas while paused and forwards them again after resume', async () => {
    await send({ type: 'pause' });
    socket().receive({ context: SELF, updates: [{ values: [{ path: 'navigation.x', value: 1 }] }] });
    await send({ type: 'resume' });
    socket().receive({ context: SELF, updates: [{ values: [{ path: 'navigation.x', value: 2 }] }] });

    expect(deltaMessages()).toEqual([
      { type: 'delta', values: [{ path: 'navigation.x', value: 2, timestamp: null }] },
    ]);
  });

  it('delivers posted values to relay subscribers as App.svelte feeds them', () => {
    const relay = createSkRelay(() => undefined);
    const received: [string, unknown, string | null][] = [];
    relay.subscribe('navigation.x', (path, value, timestamp) => received.push([path, value, timestamp]));

    socket().receive({
      context: SELF,
      updates: [{ timestamp: 'T2', values: [{ path: 'navigation.x', value: 7 }, { path: 'navigation.z', value: 8 }] }],
    });
    for (const message of deltaMessages()) relay.feed(message.values);

    expect(received).toEqual([['navigation.x', 7, 'T2']]);
  });
});
