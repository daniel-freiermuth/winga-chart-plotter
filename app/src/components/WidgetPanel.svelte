<script lang="ts">
  import { plotterExtensions, type WidgetPlacement, type WidgetDef } from '../stores/plotterExtensions.svelte';
  import { settings } from '../stores/settings.svelte';
  import type { MapControl, PanelControl } from '../lib/plotterext-host';
  import type { SkRelay } from '../lib/sk-relay';
  import WidgetCell from './WidgetCell.svelte';

  let { placement, widgetDef, mapControl, panelControl, relay }: {
    placement: WidgetPlacement;
    widgetDef: WidgetDef;
    mapControl: MapControl;
    panelControl: PanelControl;
    relay: SkRelay;
  } = $props();

  const CELL_PX = 120;
  const GAP_PX  = 4;

  function parseSize(size: string): [number, number] {
    const parts = size.split('x');
    return [parseInt(parts[0] ?? '1', 10), parseInt(parts[1] ?? '1', 10)];
  }

  const dims = $derived((() => {
    const [c, r] = parseSize(widgetDef.size);
    return { cellW: c * CELL_PX + (c - 1) * GAP_PX, cellH: r * CELL_PX + (r - 1) * GAP_PX };
  })());

  // ── Position ──────────────────────────────────────────────────────────────────

  let x = $state(0);
  let y = $state(0);

  $effect(() => { x = placement.x; y = placement.y; });

  // ── Context menu ──────────────────────────────────────────────────────────────

  let menuOpen = $state(false);

  function openConfig(): void {
    menuOpen = false;
    panelControl.openConfigPanel(placement.extensionId, placement.instanceId, placement.widgetId);
  }

  function removeWidget(): void {
    menuOpen = false;
    plotterExtensions.removeWidget(placement.instanceId);
  }

  // ── Panel ref (needed for same-origin click forwarding) ───────────────────────

  let panelEl = $state<HTMLDivElement | null>(null);

  // ── Gesture: drag + long-press + same-origin click passthrough ────────────────
  //
  // The overlay div sits in the PARENT document on top of the <iframe>.
  // Events on it are never subject to cross-document boundary / iframe implicit
  // pointer capture races. We call setPointerCapture immediately in onDown so
  // the overlay keeps the pointer even if the user moves outside the widget.
  //
  // For clicks (short press, ≤ 8 px, < 600 ms) we forward a synthetic MouseEvent
  // into the iframe's document via contentDocument.elementFromPoint — this only
  // works when the app and the Signal K server share the same origin (production).
  // Cross-origin iframes silently skip forwarding.

  const LONG_PRESS_MS  = 600;
  const MOVE_THRESHOLD = 8;  // px

  let gActive   = false;
  let gDragging = false;
  let gStartX   = 0;
  let gStartY   = 0;
  let gPanX     = 0;
  let gPanY     = 0;
  let gTimer: ReturnType<typeof setTimeout> | null = null;

  function onDown(e: PointerEvent): void {
    if (menuOpen) return; // backdrop / menu handle their own dismissal
    if (e.button > 0) return;

    e.stopPropagation(); // prevent map pan

    // Capture immediately — keeps all subsequent events on the overlay
    // regardless of pointer position, with no cross-document ambiguity.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    gActive   = true;
    gDragging = false;
    gStartX   = e.clientX;
    gStartY   = e.clientY;
    gPanX     = x;
    gPanY     = y;

    gTimer = setTimeout(() => {
      gTimer = null;
      if (!gActive || gDragging) return;
      menuOpen = true;
    }, LONG_PRESS_MS);
  }

  function onMove(e: PointerEvent): void {
    if (!gActive) return;

    const dx = e.clientX - gStartX;
    const dy = e.clientY - gStartY;

    if (!gDragging && dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
      gDragging = true;
      if (gTimer !== null) { clearTimeout(gTimer); gTimer = null; }
    }

    if (gDragging) {
      x = Math.max(0, gPanX + dx);
      y = Math.max(0, gPanY + dy);
    }
  }

  function onUp(e: PointerEvent): void {
    if (gTimer !== null) { clearTimeout(gTimer); gTimer = null; }
    if (!gActive) return;

    const wasDragging = gDragging;
    gActive   = false;
    gDragging = false;

    if (wasDragging) {
      plotterExtensions.moveWidget(placement.instanceId, x, y);
    } else if (!menuOpen) {
      // Short tap with no movement — forward as a click to the iframe when
      // the iframe is same-origin (contentDocument accessible).
      forwardClick(e);
    }
  }

  function forwardClick(e: PointerEvent): void {
    if (!panelEl) return;
    const iframeEl = panelEl.querySelector<HTMLIFrameElement>('iframe');
    if (!iframeEl) return;
    let doc: Document | null = null;
    try { doc = iframeEl.contentDocument; } catch { /* cross-origin */ }
    if (!doc) return;

    const rect = iframeEl.getBoundingClientRect();
    const relX  = e.clientX - rect.left;
    const relY  = e.clientY - rect.top;
    const target = doc.elementFromPoint(relX, relY);
    target?.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: relX, clientY: relY,
    }));
  }

  function onCancel(_e: PointerEvent): void {
    if (gTimer !== null) { clearTimeout(gTimer); gTimer = null; }
    if (!gActive) return;
    gActive = false;
    if (gDragging) {
      gDragging = false;
      x = gPanX; y = gPanY; // snap back
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={panelEl}
  class="widget-panel"
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
    width={dims.cellW}
    height={dims.cellH}
  />

  <!-- Full-surface overlay: lives entirely in the parent document so pointer
       events never cross a document boundary. Drag and long-press are
       detected here; clicks are forwarded to the iframe when same-origin. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="widget-overlay"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onCancel}
  ></div>

  {#if menuOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="widget-menu" onpointerdown={(e) => { e.stopPropagation(); }}>
      {#if widgetDef.configPanel}
        <button class="widget-menu-item" onclick={openConfig}>Configure</button>
      {/if}
      <button class="widget-menu-item widget-menu-item--danger" onclick={removeWidget}>Remove</button>
    </div>
    <!-- Full-viewport backdrop dismisses the menu on outside tap. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="widget-menu-backdrop"
      onpointerdown={(e) => { e.stopPropagation(); menuOpen = false; }}
    ></div>
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

  /* The overlay sits above the iframe in the parent document.
     touch-action: none prevents the browser from issuing pointercancel
     for scroll/zoom gestures on this element. */
  .widget-overlay {
    position: absolute;
    inset: 0;
    z-index: 1;
    cursor: grab;
    touch-action: none;
    border-radius: 8px;
  }

  .widget-menu {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #1a2a3e;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    z-index: 3;
    min-width: 120px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.8);
  }

  .widget-menu-item {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.85);
    font-size: 13px;
    padding: 7px 12px;
    text-align: left;
    border-radius: 5px;
    cursor: pointer;
    white-space: nowrap;
  }

  @media (hover: hover) and (pointer: fine) {
    .widget-menu-item:hover { background: rgba(255, 255, 255, 0.1); }
    .widget-menu-item--danger:hover { background: rgba(239, 68, 68, 0.25); color: #fca5a5; }
  }

  /* Covers the viewport to catch outside taps while the menu is open. */
  .widget-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2;
  }
</style>
