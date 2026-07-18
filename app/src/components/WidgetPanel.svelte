<script lang="ts">
  import { plotterExtensions, type WidgetPlacement, type WidgetDef } from '../stores/plotterExtensions.svelte';
  import { settings } from '../stores/settings.svelte';
  import type { MapControl, PanelControl } from '../lib/plotterext-host';
  import type { SkRelay } from '../lib/sk-relay';
  import WidgetCell from './WidgetCell.svelte';
  import FaIcon from '../lib/FaIcon.svelte';
  import { faTrashCan } from '@fortawesome/free-solid-svg-icons';

  let { placement, widgetDef, mapControl, panelControl, relay }: {
    placement: WidgetPlacement;
    widgetDef: WidgetDef;
    mapControl: MapControl;
    panelControl: PanelControl;
    relay: SkRelay;
  } = $props();

  const CELL_PX = 120;
  const GAP_PX  = 4;
  const MIN_SIZE = 60;  // minimum widget dimension in pixels

  function parseSize(size: string): [number, number] {
    const parts = size.split('x');
    return [parseInt(parts[0] ?? '1', 10), parseInt(parts[1] ?? '1', 10)];
  }

  // Effective pixel dimensions: per-instance pixel override falls back to manifest default.
  const dims = $derived((() => {
    const [defC, defR] = parseSize(widgetDef.size);
    const defW = defC * CELL_PX + (defC - 1) * GAP_PX;
    const defH = defR * CELL_PX + (defR - 1) * GAP_PX;
    return { cellW: placement.w ?? defW, cellH: placement.h ?? defH };
  })());

  // ── Position ───────────────────────────────────────────────────────────────

  let x = $state(0);
  let y = $state(0);

  $effect(() => { x = placement.x; y = placement.y; });

  // ── Live size ──────────────────────────────────────────────────────────────
  // Tracks the pointer freely during resize; persisted as raw pixels on release.
  // Re-synced from dims whenever the persisted placement changes.

  let liveW = $state(0);
  let liveH = $state(0);

  $effect(() => { liveW = dims.cellW; liveH = dims.cellH; });


  // ── Arrange mode ──────────────────────────────────────────────────────────
  // Normal mode: overlay is pointer-events:none → iframe receives all events
  // natively (no forwarding hack; works cross-origin too).
  // Arrange mode: overlay captures for drag-to-move; corner controls appear.

  let arrangeMode = $state(false);
  let panelEl = $state<HTMLDivElement | null>(null);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; arrangeMode = false; }, 8000);
  }

  function enterArrange(): void {
    arrangeMode = true;
    resetIdleTimer();
  }

  function exitArrange(): void {
    arrangeMode = false;
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
  }

  // Tap anywhere outside the widget exits arrange mode.
  // capture:true fires before any other handler, so the map is not blocked.
  $effect(() => {
    if (!arrangeMode) return;
    function onDocDown(e: PointerEvent): void {
      if (!panelEl?.contains(e.target as Node)) exitArrange();
    }
    document.addEventListener('pointerdown', onDocDown, { capture: true });
    return () => { document.removeEventListener('pointerdown', onDocDown, { capture: true }); };
  });

  // ── Actions ───────────────────────────────────────────────────────────────

  function openConfig(): void {
    exitArrange();
    panelControl.openConfigPanel(placement.extensionId, placement.instanceId, placement.widgetId);
  }

  function removeWidget(): void {
    exitArrange();
    plotterExtensions.removeWidget(placement.instanceId);
  }

  // ── Body drag (arrange mode only) ─────────────────────────────────────────

  let gActive   = false;
  let gDragging = false;
  let gStartX   = 0;
  let gStartY   = 0;
  let gPanX     = 0;
  let gPanY     = 0;

  const MOVE_THRESHOLD = 8; // px — below this, a press is a tap, not a drag

  function onBodyDown(e: PointerEvent): void {
    if (e.button > 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gActive   = true;
    gDragging = false;
    gStartX   = e.clientX;
    gStartY   = e.clientY;
    gPanX     = x;
    gPanY     = y;
    resetIdleTimer();
  }

  function onBodyMove(e: PointerEvent): void {
    if (!gActive) return;
    const dx = e.clientX - gStartX;
    const dy = e.clientY - gStartY;
    if (!gDragging && dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
      gDragging = true;
    }
    if (gDragging) {
      x = Math.max(0, gPanX + dx);
      y = Math.max(0, gPanY + dy);
    }
  }

  function onBodyUp(_e: PointerEvent): void {
    if (!gActive) return;
    const wasDragging = gDragging;
    gActive   = false;
    gDragging = false;
    if (wasDragging) {
      plotterExtensions.moveWidget(placement.instanceId, x, y);
    }
    resetIdleTimer();
  }

  function onBodyCancel(_e: PointerEvent): void {
    if (!gActive) return;
    gActive   = false;
    gDragging = false;
    x = gPanX;
    y = gPanY;
  }

  // ── Resize handle ─────────────────────────────────────────────────────────

  let rActive = false;
  let rStartX = 0;
  let rStartY = 0;
  let rStartW = 0;
  let rStartH = 0;


  function onResizeDown(e: PointerEvent): void {
    if (e.button > 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    rActive = true;
    rStartX = e.clientX;
    rStartY = e.clientY;
    rStartW = liveW;
    rStartH = liveH;
    resetIdleTimer();
  }

  function onResizeMove(e: PointerEvent): void {
    if (!rActive) return;
    liveW = Math.max(MIN_SIZE, rStartW + (e.clientX - rStartX));
    liveH = Math.max(MIN_SIZE, rStartH + (e.clientY - rStartY));
  }

  function onResizeUp(_e: PointerEvent): void {
    if (!rActive) return;
    rActive = false;
    plotterExtensions.resizeWidget(placement.instanceId, liveW, liveH);
    resetIdleTimer();
  }

  function onResizeCancel(_e: PointerEvent): void {
    if (!rActive) return;
    rActive = false;
    liveW = dims.cellW;
    liveH = dims.cellH;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={panelEl}
  class="widget-panel"
  class:widget-panel--arrange={arrangeMode}
  style="left:{x}px;top:{y}px;"
>
  <WidgetCell
    url={plotterExtensions.resolveUrl(settings.signalkHttpUrl, widgetDef.url)}
    extensionId={placement.extensionId}
    widgetId={widgetDef.id}
    instanceId={placement.instanceId}
    {mapControl}
    {panelControl}
    {relay}
    width={liveW}
    height={liveH}
  />

  <!-- Overlay: transparent in normal mode (iframe gets native events);
       captures in arrange mode for drag-to-move.
       touch-action:none prevents the browser issuing pointercancel on scroll. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="widget-overlay"
    style="pointer-events:{arrangeMode ? 'auto' : 'none'};"
    onpointerdown={onBodyDown}
    onpointermove={onBodyMove}
    onpointerup={onBodyUp}
    onpointercancel={onBodyCancel}
  ></div>


  <!-- Badge: always present in top-right; sole entry/exit point for arrange mode -->
  <button
    class="widget-badge"
    class:widget-badge--arrange={arrangeMode}
    aria-label={arrangeMode ? 'Done arranging' : 'Arrange widget'}
    onclick={arrangeMode ? exitArrange : enterArrange}
  >{arrangeMode ? '✓' : '⠿'}</button>

  {#if arrangeMode}
    <!-- Delete: top-left -->
    <button
      class="widget-corner-btn widget-corner-btn--delete"
      aria-label="Remove widget"
      onclick={removeWidget}
    ><FaIcon icon={faTrashCan} /></button>

    <!-- Config: bottom-left (only when the widget declares a config panel) -->
    {#if widgetDef.configPanel}
      <button
        class="widget-corner-btn widget-corner-btn--config"
        aria-label="Configure widget"
        onclick={openConfig}
      >⚙</button>
    {/if}

    <!-- Resize: bottom-right -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="widget-resize-handle"
      onpointerdown={onResizeDown}
      onpointermove={onResizeMove}
      onpointerup={onResizeUp}
      onpointercancel={onResizeCancel}
    >⤡</div>
  {/if}
</div>

<style>
  .widget-panel {
    position: absolute;
    z-index: 15;
    border-radius: 8px;
    overflow: visible;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.7);
    user-select: none;
  }

  @keyframes widget-pulse {
    0%, 100% { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.7), 0 0 0 2px rgba(99, 179, 237, 0.5); }
    50%       { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.7), 0 0 0 3px rgba(99, 179, 237, 0.9); }
  }

  .widget-panel--arrange {
    animation: widget-pulse 1.8s ease-in-out infinite;
  }

  /* In arrange mode: captures pointer events for drag-to-move.
     In normal mode: pointer-events:none (set inline) so the iframe gets all
     events natively — no forwarding hack, works cross-origin. */
  .widget-overlay {
    position: absolute;
    inset: 0;
    z-index: 1;
    cursor: grab;
    touch-action: none;
    border-radius: 8px;
  }

  .widget-overlay:active { cursor: grabbing; }


  /* Badge: persistent in top-right; only parent-doc element active in normal mode */
  .widget-badge {
    position: absolute;
    top: 0;
    right: 0;
    width: 28px;
    height: 28px;
    z-index: 2;
    border: none;
    padding: 0;
    background: rgba(0, 0, 0, 0.45);
    color: rgba(255, 255, 255, 0.55);
    font-size: 13px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border-radius: 0 8px 0 6px;
    touch-action: none;
    opacity: 0.45;
    transition: opacity 0.15s, background 0.15s, color 0.15s;
    user-select: none;
  }

  @media (hover: hover) and (pointer: fine) {
    .widget-badge:hover {
      opacity: 1;
      background: rgba(0, 0, 0, 0.65);
      color: rgba(255, 255, 255, 0.9);
    }
  }

  .widget-badge--arrange {
    opacity: 1;
    background: rgba(34, 197, 94, 0.85);
    color: white;
    font-size: 16px;
  }

  /* Corner action buttons (delete top-left, config bottom-left) */
  .widget-corner-btn {
    position: absolute;
    width: 28px;
    height: 28px;
    z-index: 2;
    border: none;
    padding: 0;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    touch-action: none;
    user-select: none;
    transition: background 0.15s;
  }

  .widget-corner-btn--delete {
    top: 0;
    left: 0;
    background: rgba(239, 68, 68, 0.85);
    color: white;
    border-radius: 8px 0 6px 0;
  }

  .widget-corner-btn--config {
    bottom: 0;
    left: 0;
    background: rgba(20, 40, 70, 0.85);
    color: rgba(255, 255, 255, 0.8);
    border-radius: 0 6px 0 8px;
  }

  @media (hover: hover) and (pointer: fine) {
    .widget-corner-btn--delete:hover { background: rgba(239, 68, 68, 1); }
    .widget-corner-btn--config:hover { background: rgba(40, 80, 130, 0.9); color: white; }
  }

  /* Resize handle: bottom-right corner */
  .widget-resize-handle {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 28px;
    height: 28px;
    z-index: 2;
    background: rgba(20, 40, 70, 0.85);
    color: rgba(255, 255, 255, 0.8);
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: se-resize;
    touch-action: none;
    border-radius: 0 0 8px 0;
    user-select: none;
    transition: background 0.15s;
  }

  @media (hover: hover) and (pointer: fine) {
    .widget-resize-handle:hover { background: rgba(40, 80, 130, 0.9); color: white; }
  }
</style>
