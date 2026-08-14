<script lang="ts">
  import type { MapControl, PanelControl } from '../lib/plotterext-host';
  import { attachExtensionFrame, type AttachedExtensionFrame } from '../lib/extensionFrameHost';
  import type { FrameState } from '../lib/extensionFrame';
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
  // Deliberately not $state: the controller pushes what the UI needs through
  // `onState`, and nothing should re-run merely because the handle was swapped.
  let attached: AttachedExtensionFrame | null = null;

  $effect(() => {
    const el = iframe;
    // `url` is a dependency: pointing the cell at a different extension page is
    // a new context, not a reload of this one.
    const src = url;
    if (!el) return;

    const handle = attachExtensionFrame({
      frame: el,
      url: src,
      extensionId,
      context: { kind: 'widget', id: widgetId, instanceId },
      relay,
      mapControl,
      panelControl,
      watchInstanceState: true,
      onState: (state) => { frame = state; },
    });
    if (!handle) return;
    attached = handle;

    return () => {
      attached = null;
      handle.detach();
    };
  });

  // The stream coming back means the server is serving again — a frame that
  // gave up gets one free retry out of it, so a widget mounted while the server
  // was restarting recovers without the user touching anything.
  let lastEpoch = -1;
  $effect(() => {
    const epoch = connection.epoch;
    // First observation is the baseline — mounting during an existing
    // connection is not a reconnect and must not reload a healthy frame.
    if (lastEpoch === -1) { lastEpoch = epoch; return; }
    if (epoch === lastEpoch) return;
    lastEpoch = epoch;
    attached?.noteReconnect();
  });
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
      <button class="widget-status-btn" onclick={() => attached?.retryNow()}>Retry</button>
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
