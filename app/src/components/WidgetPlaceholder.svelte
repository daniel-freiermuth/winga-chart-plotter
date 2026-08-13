<script lang="ts">
  import { plotterExtensions, type WidgetPlacement } from '../stores/plotterExtensions.svelte';
  import FaIcon from '../lib/FaIcon.svelte';
  import { faTrashCan } from '@fortawesome/free-solid-svg-icons';

  let { placement }: { placement: WidgetPlacement } = $props();

  // A placed widget whose manifest is not (yet) known used to render as
  // nothing at all — indistinguishable from a widget the user never added,
  // and the single most confusing symptom of a Signal K server that was down
  // or still starting when the app booted. Say what is going on instead.
  const state = $derived.by(() => {
    switch (plotterExtensions.status) {
      case 'idle':
      case 'loading':
        return { text: 'Loading extension…', detail: '', canRemove: false };
      case 'error':
        return {
          text: 'Extensions unavailable',
          detail: plotterExtensions.error ?? '',
          canRemove: false,
        };
      case 'ready':
        return {
          text: `${placement.widgetId} unavailable`,
          detail: 'Extension not installed on this server',
          canRemove: true,
        };
    }
  });

  const size = $derived({ w: placement.w ?? 120, h: placement.h ?? 120 });
</script>

<div
  class="widget-placeholder"
  class:widget-placeholder--error={plotterExtensions.status === 'error'}
  style="left:{placement.x}px;top:{placement.y}px;width:{size.w}px;height:{size.h}px;"
>
  <span class="widget-placeholder-text">{state.text}</span>
  {#if state.detail}
    <span class="widget-placeholder-detail">{state.detail}</span>
  {/if}
  <div class="widget-placeholder-actions">
    <button class="widget-placeholder-btn" onclick={() => { plotterExtensions.reload(); }}>Retry</button>
    {#if state.canRemove}
      <button
        class="widget-placeholder-btn"
        aria-label="Remove widget"
        onclick={() => { plotterExtensions.removeWidget(placement.instanceId); }}
      ><FaIcon icon={faTrashCan} /></button>
    {/if}
  </div>
</div>

<style>
  .widget-placeholder {
    position: absolute;
    z-index: 15;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 6px;
    box-sizing: border-box;
    text-align: center;
    border-radius: 8px;
    border: 1px dashed rgba(255, 255, 255, 0.2);
    background: rgba(20, 24, 34, 0.85);
    color: rgba(255, 255, 255, 0.7);
    font-family: system-ui, sans-serif;
    font-size: 11px;
    line-height: 1.3;
    overflow: hidden;
    user-select: none;
  }

  .widget-placeholder--error { color: #fca5a5; }

  .widget-placeholder-text {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .widget-placeholder-detail {
    font-size: 10px;
    opacity: 0.7;
    overflow-wrap: anywhere;
  }

  .widget-placeholder-actions {
    display: flex;
    gap: 6px;
  }

  .widget-placeholder-btn {
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.08);
    color: white;
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
  }

  @media (hover: hover) and (pointer: fine) {
    .widget-placeholder-btn:hover { background: rgba(255, 255, 255, 0.18); }
  }
</style>
