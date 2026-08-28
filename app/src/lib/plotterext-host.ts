import { HostConnection, windowPort, RpcError, BUS_ID, EVENT_READY } from 'signalk-plotterext-bus/host';
import type { BusPort, HandshakeContext, MethodHandler } from 'signalk-plotterext-bus/host';
import { plotterExtensions } from '../stores/plotterExtensions.svelte';
import { settings } from '../stores/settings.svelte';
import { auth } from '../stores/auth.svelte';
import type { SkRelay } from './sk-relay';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface MapControl {
  /** Visible area across panes — in split view, the dateline-aware union of both cameras. */
  getView(): { center: [number, number]; zoom: number; bounds: [number, number, number, number] };
  /**
   * Compatibility no-op: extensions may not steer the camera (navigation
   * intent comes from the user). Calls are ignored with a console warning.
   */
  flyTo(position: [number, number], zoom?: number): void;
  /** Compatibility no-op — see {@link MapControl.flyTo}. */
  fitBounds(bounds: [number, number, number, number]): void;
}

export interface PanelControl {
  openPanel(extensionId: string, panelId: string): void;
  togglePanel(extensionId: string, panelId: string): void;
  closePanel(): void;
  openConfigPanel(extensionId: string, instanceId: string, widgetId: string): void;
  toggleConfigPanel(extensionId: string, instanceId: string, widgetId: string): void;
}

/** A live host↔extension connection plus the resources it owns. */
export interface ExtensionHost {
  readonly conn: HostConnection;
  /**
   * Close the bus endpoint *and* release every Signal K subscription made
   * through it. Closing the endpoint alone would leave the relay fanning
   * values out to a dead connection and keep the paths subscribed upstream
   * for the rest of the session.
   */
  close(): void;
}

export interface HostConnectionHooks {
  /** Called whenever the frame announces itself with `bus.ready`. */
  onReady?: () => void;
}

// ── Internal constants ───────────────────────────────────────────────────────

const HOST_CAPABILITIES = [
  'widgets', 'panels.iframe', 'signalk.stream',
  'signalk.put', 'units', 'map', 'ui',
] as const;

/** Network budget for host-side REST calls made on an extension's behalf.
 *  Comfortably under the bus's own 10 s call timeout, so the extension sees a
 *  proper JSON-RPC error instead of a timeout it cannot explain. */
const PUT_TIMEOUT_MS = 8_000;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createHostConnection(
  peer: Window,
  extensionId: string,
  context: HandshakeContext,
  relay: SkRelay,
  mapControl: MapControl,
  panelControl: PanelControl,
  hooks: HostConnectionHooks = {},
): ExtensionHost {
  let seq = 0;
  const subMap = new Map<string, string[]>();
  const defaultScope = context.kind === 'background' ? 'extension' : 'instance';

  function releaseAllSubscriptions(): void {
    for (const relayIds of subMap.values()) {
      for (const id of relayIds) relay.unsubscribe(id);
    }
    subMap.clear();
  }

  /** Instance-scoped calls are only meaningful for widget/panel contexts. */
  function requireInstanceId(): string {
    const instanceId = context.instanceId;
    if (typeof instanceId !== 'string' || instanceId === '') {
      throw new RpcError('No widget instance is bound to this context', {
        code: -32602, reason: 'no_instance',
      });
    }
    return instanceId;
  }

  // Methods that do NOT need access to the HostConnection itself.
  const staticMethods: Record<string, MethodHandler> = {
    'signalk.unsubscribe'(params) {
      const { subscriptionId } = params as { subscriptionId: string };
      const relayIds = subMap.get(subscriptionId);
      if (relayIds) {
        for (const id of relayIds) relay.unsubscribe(id);
        subMap.delete(subscriptionId);
      }
    },

    async 'signalk.put'(params) {
      const { path, value } = params as { path: string; value: unknown };
      const url = `${settings.signalkHttpUrl}/signalk/v1/api/vessels/self/${path.replace(/\./g, '/')}`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...auth.authHeaders },
          body: JSON.stringify({ value }),
          // An unreachable or wedged server must fail the call, not hang it:
          // without this the promise outlives the bus's own call timeout and
          // the extension is told "timeout" with no idea what went wrong.
          signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
        });
      } catch (err) {
        throw new RpcError(
          `PUT unreachable: ${err instanceof Error ? err.message : String(err)}`,
          { code: -32000, reason: 'put_unreachable' },
        );
      }
      if (!res.ok) {
        throw new RpcError(
          `PUT failed: ${String(res.status)} ${res.statusText}`,
          {
            code: -32000,
            reason: res.status === 401 || res.status === 403 ? 'unauthorized' : 'put_failed',
          },
        );
      }
    },

    'state.get'(params) {
      const { scope: rawScope, keys } = (params ?? {}) as { scope?: 'instance' | 'extension'; keys?: string[] };
      const scope = rawScope ?? defaultScope;
      if (scope === 'extension') return { values: plotterExtensions.getExtState(extensionId, keys) };
      return { values: plotterExtensions.getInstanceState(extensionId, requireInstanceId(), keys) };
    },

    'units.get'(_params) {
      return { units: { speed: 'kn', distance: 'naut-mile', depth: 'm', length: 'm', temperature: 'C' } };
    },

    'map.getView'(_params) { return mapControl.getView(); },

    'map.center'(params) {
      const { position, zoom } = params as { position: [number, number]; zoom?: number };
      mapControl.flyTo(position, zoom);
    },

    'map.fitBounds'(params) {
      const { bounds } = params as { bounds: [number, number, number, number] };
      mapControl.fitBounds(bounds);
    },

    'ui.openPanel'(params) {
      const { panel } = params as { panel: string };
      panelControl.openPanel(extensionId, panel);
    },

    'ui.togglePanel'(params) {
      const { panel } = params as { panel: string };
      panelControl.togglePanel(extensionId, panel);
    },

    'ui.closePanel'(_params) { panelControl.closePanel(); },

    'ui.openConfigPanel'(_params) {
      panelControl.openConfigPanel(extensionId, requireInstanceId(), context.id);
    },

    'ui.toggleConfigPanel'(_params) {
      panelControl.toggleConfigPanel(extensionId, requireInstanceId(), context.id);
    },
  };

  // Sniff inbound traffic for `bus.ready` before the connection sees it: it is
  // the only signal the host gets that a *new* document is live in the frame.
  const basePort = windowPort(peer, { origin: '*' });
  const port: BusPort = {
    post: (data) => { basePort.post(data); },
    listen: (handler) => basePort.listen((data) => {
      if (isReadyEnvelope(data)) {
        // A `bus.ready` arriving while subscriptions are registered can only
        // come from a *different* document, so its predecessor's subscriptions
        // are orphaned and must go before the new document registers its own —
        // otherwise the relay fans every value out twice and holds the path
        // upstream forever.
        //
        // The invariant holds without any timing guess. A client announces
        // itself only until the handshake answers, and only subscribes after
        // that; postMessage is FIFO per source, so once a subscription of that
        // document has been processed, none of its own announcements can still
        // be in flight behind it. (An extension that re-runs connectExtension()
        // in place is treated the same, correctly: its earlier subscription ids
        // belong to a client it has thrown away.)
        if (subMap.size > 0) releaseAllSubscriptions();
        hooks.onReady?.();
      }
      handler(data);
    }),
  };

  const conn = new HostConnection({
    port,
    hostInfo: {
      host: 'signalk-chart-rs',
      hostVersion: '0.1.0',
      apiVersion: '1',
      capabilities: [...HOST_CAPABILITIES],
    },
    context,
    methods: staticMethods,
    onError(err) { console.error('[plotterext-host] error:', err); },
  });

  // These two methods need conn.publish — registered after construction.
  conn.registerMethod('signalk.subscribe', (params) => {
    const { paths } = params as { paths: string[] };
    const compoundId = `sk-sub-${String(++seq)}`;
    const relayIds: string[] = [];
    for (const path of paths) {
      const relayId = relay.subscribe(path, (_p, value, timestamp) => {
        conn.publish(`sk.${path}`, { path, value, timestamp });
      });
      relayIds.push(relayId);
    }
    subMap.set(compoundId, relayIds);
    return { subscriptionId: compoundId };
  });

  conn.registerMethod('state.set', (params) => {
    const { scope: rawScope, values } = params as { scope?: 'instance' | 'extension'; values: Record<string, unknown> };
    const scope = rawScope ?? defaultScope;
    if (scope === 'extension') {
      plotterExtensions.setExtState(extensionId, values);
    } else {
      plotterExtensions.setInstanceState(extensionId, requireInstanceId(), values);
    }
    conn.publish('state.changed', {
      scope,
      instanceId: context.instanceId ?? null,
      keys: Object.keys(values),
    });
  });

  return {
    conn,
    close(): void {
      conn.close();
      releaseAllSubscriptions();
    },
  };
}

/** True for `{bus: 'plotterExt/1', msg: {method: 'bus.ready', …}}` envelopes. */
function isReadyEnvelope(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const env = data as { bus?: unknown; msg?: unknown };
  if (env.bus !== BUS_ID) return false;
  if (typeof env.msg !== 'object' || env.msg === null) return false;
  return (env.msg as { method?: unknown }).method === EVENT_READY;
}
