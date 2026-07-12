<script lang="ts">
  import type { StyleSpecification } from 'maplibre-gl';
  import { cubicOut } from 'svelte/easing';
  import { charts } from '../stores/charts.svelte';
  import { baseLayers, BASE_LAYERS } from '../stores/baseLayers.svelte';
  import { mapView } from '../stores/mapView.svelte';
  import FaIcon from '../lib/FaIcon.svelte';
  import { faGlobe, faMap } from '@fortawesome/free-solid-svg-icons';
  import MapThumb from './MapThumb.svelte';

  let {
    isOpen = $bindable(false),
    onToggleProjection,
  }: {
    isOpen?: boolean;
    onToggleProjection?: () => void;
  } = $props();

  // Sheet height in dvh units.  Starts at 52; grows via drag or scroll wheel.
  let sheetHeight = $state(52);
  // Reactive so the CSS .dragging class can disable transitions during live drag.
  let isDragging  = $state(false);
  let _dragY = 0;

  export function open() { isOpen = true; sheetHeight = 52; }
  function close()       { isOpen = false; }

  // ── Handle drag ── live height tracking, snap on release ─────────────────
  function onHandleDown(e: PointerEvent) {
    _dragY     = e.clientY;
    isDragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onHandleMove(e: PointerEvent) {
    if (!isDragging) return;
    const dy   = e.clientY - _dragY; // positive = dragged down = shrink
    const dh   = -(dy / window.innerHeight) * 100;
    sheetHeight = Math.max(20, Math.min(100, sheetHeight + dh));
    _dragY     = e.clientY;
  }

  function onHandleUp() {
    isDragging = false;
    // Snap to nearest breakpoint
    if      (sheetHeight > 80) sheetHeight = 100;
    else if (sheetHeight > 36) sheetHeight = 52;
    else                       close();
  }

  // ── Scroll wheel: grow the sheet proportionally, then scroll normally ─────
  let _scrollEl = $state<HTMLDivElement | undefined>();

  $effect(() => {
    const el = _scrollEl;
    if (!el) return;
    const div: HTMLDivElement = el;

    // ── Desktop / trackpad: wheel events ─────────────────────────────────
    function onWheel(e: WheelEvent) {
      const px    = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
      const atTop = div.scrollTop === 0;
      if (px > 0 && sheetHeight < 100 && atTop) {
        e.preventDefault();
        sheetHeight = Math.min(100, sheetHeight + px * 0.08);
      } else if (px < 0 && sheetHeight > 52 && atTop) {
        e.preventDefault();
        sheetHeight = Math.max(52, sheetHeight + px * 0.08);
      }
    }

    // ── Mobile: touch events ──────────────────────────────────────────────
    // Intercept the touch sequence when the user starts at scrollTop=0 and
    // swipes with a clear vertical direction — expand or shrink the sheet.
    // Once intercepting, preventDefault() suppresses native scroll for the
    // entire sequence so height updates are smooth without scroll fighting.
    let _tY0 = 0, _tH0 = 0, _tTop0 = 0, _intercepting = false;

    function onTouchStart(e: TouchEvent) {
      _tY0          = e.touches[0]!.clientY;
      _tH0          = sheetHeight;
      _tTop0        = div.scrollTop;
      _intercepting = false;
    }

    function onTouchMove(e: TouchEvent) {
      const dy = e.touches[0]!.clientY - _tY0;   // + = finger moved down
      const dh = -(dy / window.innerHeight) * 100; // + = expand, − = shrink

      if (!_intercepting && _tTop0 === 0 && Math.abs(dy) > 4) {
        if ((dh > 0 && _tH0 < 100) || (dh < 0 && _tH0 > 52)) {
          _intercepting = true;
          isDragging    = true; // disable CSS transition while dragging
        }
      }

      if (_intercepting) {
        e.preventDefault();
        sheetHeight = Math.max(52, Math.min(100, _tH0 + dh));
      }
    }

    function onTouchEnd() {
      if (!_intercepting) return;
      _intercepting = false;
      isDragging    = false; // re-enable transition for any subsequent snap (handle drag)
      // No breakpoint snap here — sheet stays wherever the user left it.
      // The handle-bar onHandleUp is the deliberate resize gesture that snaps.
    }

    div.addEventListener('wheel',       onWheel,      { passive: false });
    div.addEventListener('touchstart',  onTouchStart, { passive: true  });
    div.addEventListener('touchmove',   onTouchMove,  { passive: false });
    div.addEventListener('touchend',    onTouchEnd);
    div.addEventListener('touchcancel', onTouchEnd);
    return () => {
      div.removeEventListener('wheel',       onWheel);
      div.removeEventListener('touchstart',  onTouchStart);
      div.removeEventListener('touchmove',   onTouchMove);
      div.removeEventListener('touchend',    onTouchEnd);
      div.removeEventListener('touchcancel', onTouchEnd);
    };
  });

  // ── Preview helpers ───────────────────────────────────────────────────────

  // Stable object cache keyed by tile URL.  SvelteSet fires coarsely, so any
  // chart selection change re-evaluates every {#each} item body, which would
  // call rasterStyle() again and produce a new object reference — enough to
  // re-run MapThumb's fetch $effect and recreate the MapLibre instance.
  // Returning the same reference for the same URL short-circuits Svelte's prop
  // diffing so MapThumb never sees a "changed" style prop.
  // Intentionally plain Map (not SvelteMap): mutating reactive state inside a template expression
  // causes state_unsafe_mutation. This cache is pure memoization — it must not be reactive.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const _rasterStyleCache = new Map<string, StyleSpecification>();

  function rasterStyle(tileUrl: string): StyleSpecification {
    let s = _rasterStyleCache.get(tileUrl);
    if (!s) {
      s = {
        version: 8,
        sources: { chart: { type: 'raster', tiles: [tileUrl], tileSize: 256 } },
        layers:  [{ id: 'chart', type: 'raster', source: 'chart' }],
      };
      _rasterStyleCache.set(tileUrl, s);
    }
    return s;
  }


  function clickWmts(chartId: string, layerId: string, layerTileUrl: string) {
    // No-op if this exact layer is already active (never deactivates).
    if (charts.selected.has(chartId) && charts.getLayerSel(chartId) === layerId) return;
    baseLayers.deselectAll();
    if (!charts.selected.has(chartId)) charts.toggle(chartId);
    // activateLayer is synchronous: writes wmtsResolved + wmtsLayerSel in the same
    // turn as toggle(), so Svelte batches everything into one render — no wrong-layer flash.
    charts.activateLayer(chartId, layerId, layerTileUrl);
  }

  // Slide-up entrance / slide-down exit
  function slideUp(node: Element, { duration = 260 }: { duration?: number } = {}) {
    void node;
    return {
      duration,
      easing: cubicOut,
      css: (t: number) => `transform: translateY(${String((1 - t) * 100)}%)`,
    };
  }
</script>

{#if isOpen}
  <div class="sheet" class:dragging={isDragging}
       style="height: {String(Math.round(sheetHeight))}dvh; border-radius: {sheetHeight >= 99 ? '0' : '14px 14px 0 0'}"
       transition:slideUp>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="handle-bar"
      onpointerdown={onHandleDown}
      onpointermove={onHandleMove}
      onpointerup={onHandleUp}
      onpointercancel={onHandleUp}
    >
      <span class="handle"></span>
    </div>

    <div class="sheet-header">
      <div class="proj-seg">
        <button
          class="proj-opt"
          class:proj-opt--active={mapView.projection === 'mercator'}
          title="Mercator projection"
          onclick={() => { if (mapView.projection !== 'mercator') onToggleProjection?.(); }}
        >
          <FaIcon icon={faMap} /> Mercator
        </button>
        <button
          class="proj-opt"
          class:proj-opt--active={mapView.projection === 'globe'}
          title="Globe projection"
          onclick={() => { if (mapView.projection !== 'globe') onToggleProjection?.(); }}
        >
          <FaIcon icon={faGlobe} /> Globe
        </button>
      </div>
      <button class="close-btn" onclick={close} title="Close">✕</button>
    </div>

    <div class="sheet-scroll" bind:this={_scrollEl}>
      <div class="grid">

        <!-- ── Base layers ──────────────────────────────────────────────── -->
        {#each BASE_LAYERS as layer (layer.id)}
          <button
            class="card"
            class:selected={baseLayers.enabled.has(layer.id)}
            aria-pressed={baseLayers.enabled.has(layer.id)}
            onclick={() => { charts.deselectAll(); baseLayers.toggle(layer.id); }}
          >
            <div class="card-preview">
              <MapThumb style={rasterStyle(layer.tileUrl)} />
            </div>
            <div class="card-label">{layer.name}</div>
          </button>
        {/each}

        <!-- ── SignalK charts ────────────────────────────────────────────── -->
        {#if charts.loading}
          <div class="card card--ghost">
            <div class="card-preview card-preview--pulse"></div>
            <div class="card-label">Loading charts…</div>
          </div>
        {:else if charts.error}
          <div class="card card--disabled">
            <div class="card-preview"></div>
            <div class="card-label">Error: {charts.error}</div>
          </div>
        {:else}
          {#each Object.entries(charts.available) as [id, chart] (id)}
            {@const styleUrl   = charts.styleUrl(chart)}
            {@const tileUrl    = charts.tileUrl(chart)}

            {#if styleUrl}
              <!-- Vector / style-based — one live MapThumb per chart -->
              <button
                class="card"
                class:selected={charts.selected.has(id)}
                aria-pressed={charts.selected.has(id)}
                onclick={() => { baseLayers.deselectAll(); charts.toggle(id); }}
              >
                <div class="card-preview">
                  <MapThumb style={styleUrl} bounds={chart.bounds} />
                </div>
                <div class="card-label">{chart.name}</div>
              </button>

            {:else if chart.type === 'WMTS'}
              <!-- WMTS — one card per visible layer -->
              {#if charts.wmtsResolving.has(id) && charts.visibleLayers(id).length === 0}
                <!-- Capabilities still loading -->
                <div class="card card--ghost">
                  <div class="card-preview card-preview--pulse"></div>
                  <div class="card-label">{chart.name}</div>
                  <div class="card-sub">Loading layers…</div>
                </div>
              {:else if charts.visibleLayers(id).length === 0}
                <!-- Failed or no layers -->
                <div class="card card--disabled">
                  <div class="card-preview"></div>
                  <div class="card-label">{chart.name}</div>
                  <div class="card-sub">
                    {charts.wmtsFailed.has(id) ? 'Failed to load' : 'No layers'}
                  </div>
                </div>
              {:else}
                {#each charts.visibleLayers(id) as layer (layer.id)}
                  {@const isActive = charts.selected.has(id) && charts.getLayerSel(id) === layer.id}
                  <button
                    class="card"
                    class:selected={isActive}
                    aria-pressed={isActive}
                    onclick={() => { clickWmts(id, layer.id, layer.tileUrl); }}
                  >
                    <div class="card-preview">
                      {#if layer.tileUrl}
                        <MapThumb
                          style={rasterStyle(layer.tileUrl)}
                          bounds={chart.bounds}
                        />
                      {:else}
                        <div class="card-preview--pulse" style="width:100%;height:100%"></div>
                      {/if}
                    </div>
                    <div class="card-label">{chart.name}</div>
                    <div class="card-sub">{layer.title}</div>
                  </button>
                {/each}
              {/if}

            {:else}
              <!-- Raster tile chart (tilelayer, WMS, pbf …) -->
              <button
                class="card"
                class:selected={charts.selected.has(id)}
                aria-pressed={charts.selected.has(id)}
                onclick={() => { baseLayers.deselectAll(); charts.toggle(id); }}
              >
                <div class="card-preview">
                  {#if tileUrl}
                    <MapThumb
                      style={rasterStyle(tileUrl)}
                      bounds={chart.bounds}
                    />
                  {/if}
                </div>
                <div class="card-label">{chart.name}</div>
              </button>
            {/if}
          {/each}
        {/if}

      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Sheet (bottom drawer) ───────────────────────────────────────────── */
  .sheet {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 21;
    /* height set via inline style; transition applies during snap (not drag) */
    display: flex;
    flex-direction: column;
    background: #1e1e2e;
    color: white;
    box-shadow: 0 -4px 32px rgba(0, 0, 0, 0.55);
    font-family: system-ui, sans-serif;
    overflow: hidden;
  }

  /* Smooth snap animation after drag release or wheel boundary */
  .sheet:not(.dragging) {
    transition: height 0.22s cubic-bezier(0.2, 0.8, 0.3, 1),
                border-radius 0.22s;
  }


  /* ── Drag handle ─────────────────────────────────────────────────────── */
  .handle-bar {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 10px 0 8px;
    flex-shrink: 0;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .handle {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.25);
  }

  /* ── Header (projection + close) ────────────────────────────────────── */
  .sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px 12px;
    flex-shrink: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .proj-seg {
    display: flex;
    gap: 4px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    padding: 3px;
  }

  .proj-opt {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border: none;
    border-radius: 6px;
    background: none;
    color: rgba(255, 255, 255, 0.6);
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .proj-opt--active {
    background: rgba(255, 255, 255, 0.15);
    color: white;
    font-weight: 600;
  }

  .close-btn {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    font-size: 18px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    line-height: 1;
    transition: color 0.15s;
  }

  .close-btn:hover { color: white; }

  /* ── Scrollable content ──────────────────────────────────────────────── */
  .sheet-scroll {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* ── Card grid ───────────────────────────────────────────────────────── */
  .grid {
    display: grid;
    /*
     * ~1 per row on phone, ~4 per row on a 1920-px desktop:
     *   min(100%, 440px) ensures one column on narrow viewports.
     */
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr));
    gap: 14px;
    padding: 16px;
  }

  /* ── Individual card ─────────────────────────────────────────────────── */
  .card {
    /* <button> reset */
    appearance: none;
    font: inherit;
    text-align: left;
    padding: 0;
    cursor: pointer;
    color: white;

    position: relative;
    background: #252538;
    border-radius: 10px;
    overflow: hidden;
    border: 2px solid transparent;
    transition: border-color 0.15s, transform 0.12s, box-shadow 0.15s;
  }

  .card:hover {
    transform: scale(1.022);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  }

  .card:focus-visible {
    outline: none;
    border-color: rgba(76, 201, 240, 0.55);
  }

  .card.selected {
    border-color: #4cc9f0;
    box-shadow: 0 0 0 1px rgba(76, 201, 240, 0.3);
  }

  /* Checkmark badge in top-right corner */
  .card.selected::after {
    content: '✓';
    position: absolute;
    top: 8px;
    right: 9px;
    background: #4cc9f0;
    color: #1e1e2e;
    font-size: 10px;
    font-weight: 800;
    width: 19px;
    height: 19px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1;
    pointer-events: none;
  }

  .card--ghost    { opacity: 0.55; pointer-events: none; }
  .card--disabled { opacity: 0.40; pointer-events: none; }

  /* ── Preview image area ──────────────────────────────────────────────── */
  .card-preview {
    width: 100%;
    aspect-ratio: 4 / 3;
    background: #1a1a2e;
    overflow: hidden;
    display: block;
  }


  @keyframes pulse {
    0%, 100% { opacity: 0.3; }
    50%       { opacity: 0.7; }
  }

  .card-preview--pulse {
    display: block;
    width: 100%;
    height: 100%;
    background: #2a2a4e;
    animation: pulse 1.4s ease-in-out infinite;
  }

  /* ── Labels ──────────────────────────────────────────────────────────── */
  .card-label {
    padding: 9px 11px 3px;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.4;
  }

  .card-label:last-child { padding-bottom: 9px; }

  .card-sub {
    padding: 1px 11px 9px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.52);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.4;
  }
</style>
