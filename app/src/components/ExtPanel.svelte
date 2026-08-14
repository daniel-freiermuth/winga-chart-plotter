<script lang="ts">
  import { plotterExtensions } from '../stores/plotterExtensions.svelte';
  import { settings } from '../stores/settings.svelte';
  import { connection } from '../stores/connection.svelte';
  import type { MapControl, PanelControl } from '../lib/plotterext-host';
  import { attachExtensionFrame, type AttachedExtensionFrame } from '../lib/extensionFrameHost';
  import type { FrameState } from '../lib/extensionFrame';
  import type { SkRelay } from '../lib/sk-relay';

  let { mapControl, panelControl, relay }: {
    mapControl: MapControl;
    panelControl: PanelControl;
    relay: SkRelay;
  } = $props();

  // Derive the resolved panel def from the store's open state
  const panelState = $derived(plotterExtensions.openPanel);
  const panelDef = $derived(
    panelState
      ? plotterExtensions.extensions.get(panelState.extensionId)?.panels?.find(
          p => p.id === panelState.panelId,
        ) ?? null
      : null,
  );
  const resolvedUrl = $derived(
    panelState && panelDef
      ? plotterExtensions.resolveUrl(settings.signalkHttpUrl, panelDef.url)
      : null,
  );

  // iframe ref — recreated whenever resolved URL changes
  let iframe = $state<HTMLIFrameElement | null>(null);
  let frame = $state<FrameState>({ phase: 'connecting', attempt: 0 });
  // Deliberately not $state — see WidgetCell.
  let attached: AttachedExtensionFrame | null = null;

  $effect(() => {
    const el = iframe;
    const url = resolvedUrl;
    if (!el || !panelState || !panelDef || !url) return;

    const handle = attachExtensionFrame({
      frame: el,
      url,
      extensionId: panelState.extensionId,
      context: {
        kind: 'panel',
        id: panelDef.id,
        instanceId:     panelState.targetInstance ?? null,
        targetInstance: panelState.targetInstance ?? null,
        targetWidget:   panelState.targetWidget   ?? null,
      },
      relay,
      mapControl,
      panelControl,
      onState: (state) => { frame = state; },
    });
    if (!handle) return;
    attached = handle;

    return () => {
      attached = null;
      handle.detach();
    };
  });

  let lastEpoch = -1;
  $effect(() => {
    const epoch = connection.epoch;
    if (lastEpoch === -1) { lastEpoch = epoch; return; }
    if (epoch === lastEpoch) return;
    lastEpoch = epoch;
    attached?.noteReconnect();
  });
</script>

{#if panelState && panelDef && resolvedUrl}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="ext-panel-backdrop"
    onclick={() => { plotterExtensions.closePanelFor(); }}
    onkeydown={() => { plotterExtensions.closePanelFor(); }}
  ></div>

  <div class="ext-panel" class:ext-panel--config={panelState.isConfig}>
    <div class="ext-panel-header">
      <span class="ext-panel-title">{panelDef.title}</span>
      <button
        class="ext-panel-close"
        onclick={() => { plotterExtensions.closePanelFor(); }}
        title="Close"
      >✕</button>
    </div>
    <div class="ext-panel-body">
      <iframe
        bind:this={iframe}
        src={resolvedUrl}
        sandbox="allow-scripts allow-same-origin allow-forms"
        title={panelDef.title}
        style="width:100%;height:100%;border:none;display:block;"
      ></iframe>
      {#if frame.phase === 'stalled'}
        <div class="ext-panel-status">
          <span>This panel is not responding.</span>
          <button class="ext-panel-status-btn" onclick={() => attached?.retryNow()}>Retry</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ext-panel-backdrop {
    position: fixed;
    inset: 0;
    z-index: 23;
    background: transparent;
  }

  .ext-panel {
    position: fixed;
    top: 44px;
    right: 0;
    bottom: 0;
    width: 320px;
    z-index: 24;
    background: #1e1e2e;
    color: white;
    display: flex;
    flex-direction: column;
    box-shadow: -4px 0 24px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif;
  }

  /* Config / setup panel: centered dialog instead of side drawer */
  .ext-panel--config {
    top: 50%;
    right: auto;
    bottom: auto;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(400px, calc(100vw - 32px));
    height: min(520px, calc(100vh - 80px));
    border-radius: 10px;
  }

  .ext-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px 10px;
    border-bottom: 1px solid #2a2a3e;
    flex-shrink: 0;
  }

  .ext-panel-title {
    font-size: 13px;
    font-weight: 600;
    color: white;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .ext-panel-close {
    background: none;
    border: none;
    color: #666688;
    cursor: pointer;
    font-size: 14px;
    padding: 0 2px;
  }

  @media (hover: hover) and (pointer: fine) {
    .ext-panel-close:hover { color: white; }
  }

  .ext-panel-body {
    position: relative;
    flex: 1;
    overflow: hidden;
  }

  /* Covers the frame when it never came up, so a blank panel is never the
     final word — see WidgetCell for the same treatment on widgets. */
  .ext-panel-status {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 16px;
    text-align: center;
    background: #1e1e2e;
    color: #fca5a5;
    font-size: 13px;
  }

  .ext-panel-status-btn {
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.08);
    color: white;
    border-radius: 4px;
    padding: 5px 14px;
    font-size: 13px;
    cursor: pointer;
  }

  @media (hover: hover) and (pointer: fine) {
    .ext-panel-status-btn:hover { background: rgba(255, 255, 255, 0.18); }
  }
</style>
