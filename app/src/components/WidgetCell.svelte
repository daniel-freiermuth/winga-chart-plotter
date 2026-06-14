<script lang="ts">
  import { createHostConnection, type MapControl, type PanelControl } from '../lib/plotterext-host';
  import { plotterExtensions } from '../stores/plotterExtensions.svelte';
  import type { HostConnection } from 'signalk-plotterext-bus/host';
  import type { SkRelay } from '../lib/sk-relay';

  let {
    url, extensionId, widgetId, instanceId,
    mapControl, panelControl, relay,
    width, height,
  }: {
    url: string;
    extensionId: string;
    widgetId: string;
    instanceId: string;
    mapControl: MapControl;
    panelControl: PanelControl;
    relay: SkRelay;
    width: number;
    height: number;
  } = $props();

  let iframe = $state<HTMLIFrameElement | null>(null);

  $effect(() => {
    const el = iframe;
    if (!el) return;

    let conn: HostConnection | null = null;
    let unsubState: (() => void) | null = null;

    // Only connect after the iframe content has loaded; before that the
    // extension's JSON-RPC listener is not running yet.
    const onLoad = (): void => {
      conn?.close();
      unsubState?.();

      conn = createHostConnection(
        el,
        extensionId,
        { kind: 'widget', id: widgetId, instanceId },
        relay,
        mapControl,
        panelControl,
      );

      // When a config panel saves per-instance state, republish state.changed
      // to this widget's connection so it can reload its configuration.
      unsubState = plotterExtensions.onInstanceStateChanged(extensionId, instanceId, (keys) => {
        conn?.publish('state.changed', { scope: 'instance', instanceId, keys });
      });
    };

    el.addEventListener('load', onLoad);
    return () => {
      el.removeEventListener('load', onLoad);
      unsubState?.();
      conn?.close();
      conn = null;
      unsubState = null;
    };
  });
</script>

<iframe
  bind:this={iframe}
  src={url}
  sandbox="allow-scripts allow-same-origin allow-forms"
  title={widgetId}
  style="width:{width}px;height:{height}px;border:none;display:block;background:transparent;"
></iframe>
