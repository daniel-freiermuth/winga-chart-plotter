/**
 * Test doubles for the extension message bus: a stand-in for an iframe's
 * browsing context plus the `window` message pump `windowPort` listens on.
 *
 * Deliberately free of any vitest import — helpers that are not themselves
 * `*.test.ts` may not depend on devDependencies (see eslint.config.js), and
 * plain closures do the job. Same convention as `stores/testStorage.ts`.
 */
import { BUS_ID } from 'signalk-plotterext-bus/host';
import type { SkRelay } from './sk-relay';
import type { MapControl, PanelControl } from './plotterext-host';

/** Wrap a JSON-RPC message the way the bus codec does on the wire. */
export function envelope(msg: Record<string, unknown>): unknown {
  return { bus: BUS_ID, msg: { jsonrpc: '2.0', ...msg } };
}

/** Stands in for `iframe.contentWindow`. */
export interface FakePeer {
  postMessage: (data: unknown, origin: string) => void;
  location: { replace: (url: string) => void };
}

export interface BusHarness {
  peer: FakePeer;
  /** Everything the host posted into the frame, newest last. */
  posted: unknown[];
  /** URLs the frame was navigated to by `reloadFrame`. */
  reloads: string[];
  /** Deliver an inbound message as if the frame had posted it. */
  deliver: (data: unknown) => void;
  /** Undo the global message-pump stubs. */
  restore: () => void;
}

type Listener = (ev: unknown) => void;
interface ListenerHost {
  addEventListener?: (type: string, fn: Listener) => void;
  removeEventListener?: (type: string, fn: Listener) => void;
}

export function busHarness(): BusHarness {
  const listeners: Listener[] = [];
  const g = globalThis as ListenerHost;
  const priorAdd = g.addEventListener;
  const priorRemove = g.removeEventListener;

  g.addEventListener = (type, fn) => { if (type === 'message') listeners.push(fn); };
  g.removeEventListener = (_type, fn) => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };

  const posted: unknown[] = [];
  const reloads: string[] = [];
  const peer: FakePeer = {
    postMessage: (data) => posted.push(data),
    location: { replace: (url) => reloads.push(url) },
  };

  return {
    peer,
    posted,
    reloads,
    deliver: (data) => {
      for (const fn of [...listeners]) fn({ source: peer, origin: 'http://ext.local', data });
    },
    restore: () => {
      if (priorAdd) g.addEventListener = priorAdd; else delete g.addEventListener;
      if (priorRemove) g.removeEventListener = priorRemove; else delete g.removeEventListener;
      listeners.length = 0;
    },
  };
}

export interface RecordingRelay {
  relay: SkRelay;
  /** `"<relayId>:<path>"` per subscribe, in order. */
  subscribed: string[];
  /** Relay ids released, in order. */
  unsubscribed: string[];
}

export function recordingRelay(): RecordingRelay {
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  let seq = 0;
  return {
    subscribed,
    unsubscribed,
    relay: {
      feed: () => { /* deltas are fed directly in relay tests */ },
      subscribe: (path) => {
        const id = `r${String(++seq)}`;
        subscribed.push(`${id}:${path}`);
        return id;
      },
      unsubscribe: (id) => { unsubscribed.push(id); },
      resubscribe: () => { /* exercised in sk-relay tests */ },
    },
  };
}

export const noopMapControl: MapControl = {
  getView: () => ({ center: [0, 0], zoom: 0, bounds: [0, 0, 0, 0] }),
  flyTo: () => { /* noop */ },
  fitBounds: () => { /* noop */ },
};

export const noopPanelControl: PanelControl = {
  openPanel: () => { /* noop */ },
  togglePanel: () => { /* noop */ },
  closePanel: () => { /* noop */ },
  openConfigPanel: () => { /* noop */ },
  toggleConfigPanel: () => { /* noop */ },
};
