import { HostConnection, windowPort, RpcError } from 'signalk-plotterext-bus/host';
import type { HandshakeContext, MethodHandler } from 'signalk-plotterext-bus/host';
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

// ── Internal constants ───────────────────────────────────────────────────────

const HOST_CAPABILITIES = [
  'widgets', 'panels.iframe', 'signalk.stream',
  'signalk.put', 'units', 'map', 'ui',
] as const;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createHostConnection(
  iframe: HTMLIFrameElement,
  extensionId: string,
  context: HandshakeContext,
  relay: SkRelay,
  mapControl: MapControl,
  panelControl: PanelControl,
): HostConnection {
  let seq = 0;
  const subMap = new Map<string, string[]>();
  const defaultScope = context.kind === 'background' ? 'extension' : 'instance';

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
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth.authHeaders },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        throw new RpcError(
          `PUT failed: ${String(res.status)} ${res.statusText}`,
          { code: -32000, reason: 'put_failed' },
        );
      }
    },

    'state.get'(params) {
      const { scope: rawScope, keys } = (params ?? {}) as { scope?: 'instance' | 'extension'; keys?: string[] };
      const scope = rawScope ?? defaultScope;
      if (scope === 'extension') return { values: plotterExtensions.getExtState(extensionId, keys) };
      const instanceId = context.instanceId ?? '';
      return { values: plotterExtensions.getInstanceState(extensionId, instanceId, keys) };
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
      panelControl.openConfigPanel(extensionId, context.instanceId!, context.id);
    },

    'ui.toggleConfigPanel'(_params) {
      panelControl.toggleConfigPanel(extensionId, context.instanceId!, context.id);
    },
  };

  const conn = new HostConnection({
    port: windowPort(iframe.contentWindow!, { origin: '*' }),
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
      const instanceId = context.instanceId ?? '';
      plotterExtensions.setInstanceState(extensionId, instanceId, values);
    }
    conn.publish('state.changed', {
      scope,
      instanceId: context.instanceId ?? null,
      keys: Object.keys(values),
    });
  });

  return conn;
}
