<script lang="ts">
  import { createHostConnection, type MapControl, type PanelControl } from '../lib/plotterext-host';
  import { createFrameSupervisor, reloadFrame, type FrameState } from '../lib/extensionFrame';
  import { plotterExtensions } from '../stores/plotterExtensions.svelte';
  import { connection } from '../stores/connection.svelte';
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
  let frame = $state<FrameState>({ phase: 'connecting', attempt: 0 });
  // Deliberately not $state: the supervisor pushes its state out through
  // `onChange` (into `frame`), and nothing should re-run merely because the
  // handle was swapped.
  let supervisor: ReturnType<typeof createFrameSupervisor> | null = null;

  $effect(() => {
    const el = iframe;
    // `url` is a dependency: pointing the cell at a different extension page is
    // a new context, not a reload of this one.
    const src = url;
    if (!el) return;
    // The frame's WindowProxy is created with the element and survives every
    // navigation it makes, so it can be bound once, up front.
    const win = el.contentWindow;
    if (!win) return;

    frame = { phase: 'connecting', attempt: 0 };

    const sup = createFrameSupervisor({
      reload: () => { reloadFrame(el, src); },
      onChange: (state) => { frame = state; },
    });

    // Connect *before* the extension document runs. The host answers
    // `bus.ready`, so a connection created later — on the frame's `load` event,
    // as this used to do — can miss the announcement of a document whose
    // subresources are slow, and the extension then renders its own permanent
    // "timed out waiting for host handshake" error.
    const host = createHostConnection(
      win,
      extensionId,
      { kind: 'widget', id: widgetId, instanceId },
      relay,
      mapControl,
      panelControl,
      { onReady: () => { sup.noteReady(); } },
    );

    supervisor = sup;
    sup.start();

    const onLoad = (): void => { sup.noteLoad(); };
    el.addEventListener('load', onLoad);

    // When a config panel saves per-instance state, republish state.changed
    // to this widget's connection so it can reload its configuration.
    const unsubState = plotterExtensions.onInstanceStateChanged(extensionId, instanceId, (keys) => {
      host.conn.publish('state.changed', { scope: 'instance', instanceId, keys });
    });

    return () => {
      el.removeEventListener('load', onLoad);
      unsubState();
      sup.stop();
      supervisor = null;
      host.close();
    };
  });

  // The stream coming back means the server is serving again — give a frame
  // that gave up one free retry per reconnect, so a widget mounted while the
  // server was restarting recovers without the user touching anything.
  let lastEpoch = -1;
  $effect(() => {
    const epoch = connection.epoch;
    // First observation is the baseline — mounting during an existing
    // connection is not a reconnect and must not reload a healthy frame.
    if (lastEpoch === -1) { lastEpoch = epoch; return; }
    if (epoch === lastEpoch) return;
    lastEpoch = epoch;
    const sup = supervisor;
    if (sup && sup.phase !== 'live') sup.retryNow();
  });

  function retry(): void { supervisor?.retryNow(); }
</script>

<div class="widget-cell" style="width:{width}px;height:{height}px;">
  <iframe
    bind:this={iframe}
    src={url}
    sandbox="allow-scripts allow-same-origin allow-forms"
    title={widgetId}
    style="width:{width}px;height:{height}px;border:none;display:block;background:transparent;"
  ></iframe>

  {#if frame.phase === 'stalled'}
    <div class="widget-status widget-status--stalled">
      <span class="widget-status-text">Widget not responding</span>
      <button class="widget-status-btn" onclick={retry}>Retry</button>
    </div>
  {:else if frame.attempt > 0}
    <div class="widget-status">
      <span class="widget-status-text">Reloading… ({frame.attempt})</span>
    </div>
  {/if}
</div>

<style>
  .widget-cell {
    position: relative;
  }

  /* Covers the frame so a browser error page or blank document is never what
     the user is left looking at. */
  .widget-status {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 4px;
    text-align: center;
    background: rgba(20, 24, 34, 0.92);
    color: rgba(255, 255, 255, 0.75);
    border-radius: 8px;
    font-family: system-ui, sans-serif;
    font-size: 11px;
    line-height: 1.3;
  }

  .widget-status--stalled {
    color: #fca5a5;
  }

  .widget-status-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .widget-status-btn {
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.08);
    color: white;
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 11px;
    cursor: pointer;
  }

  @media (hover: hover) and (pointer: fine) {
    .widget-status-btn:hover { background: rgba(255, 255, 255, 0.18); }
  }
</style>
