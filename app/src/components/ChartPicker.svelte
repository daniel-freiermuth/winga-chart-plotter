<script lang="ts">
  import type { StyleSpecification } from 'maplibre-gl';
  import { cubicOut } from 'svelte/easing';
  import { charts, type Chart, type WmtsLayerInfo } from '../stores/charts.svelte';
  import { baseLayers, BASE_LAYERS, type BaseLayer } from '../stores/baseLayers.svelte';
  import LazyMapThumb from './LazyMapThumb.svelte';
  import { visibility, type VisibilityState } from '../stores/visibility.svelte';
  import { chartLru } from '../stores/chartLru.svelte';
  import { mapView } from '../stores/mapView.svelte';

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
  function close() {
    const activeIds: string[] = [...baseLayers.enabled];
    for (const cid of charts.selected) {
      if (charts.available[cid]?.type === 'WMTS') {
        const layerId = charts.getLayerSel(cid);
        if (layerId) activeIds.push(`${cid}:${layerId}`);
      } else {
        activeIds.push(cid);
      }
    }
    chartLru.touch(activeIds);
    isOpen = false;
  }

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
    else if (sheetHeight > 30) sheetHeight = 52;
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
      } else if (px < 0 && atTop) {
        e.preventDefault();
        const next = sheetHeight + px * 0.08;
        if (next < 30) { close(); } else { sheetHeight = Math.max(10, next); }
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
        if ((dh > 0 && _tH0 < 100) || dh < 0) {
          _intercepting = true;
          isDragging    = true; // disable CSS transition while dragging
        }
      }

      if (_intercepting) {
        e.preventDefault();
        sheetHeight = Math.max(10, Math.min(100, _tH0 + dh));
      }
    }

    function onTouchEnd() {
      if (!_intercepting) return;
      _intercepting = false;
      isDragging    = false;
      if      (sheetHeight < 30) { close(); }
      else if (sheetHeight < 52) { sheetHeight = 52; }
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
  // re-run LazyMapThumb → MapThumb's fetch $effect and recreate the MapLibre instance.
  // Returning the same reference for the same URL short-circuits Svelte's prop
  // diffing so the inner MapThumb never sees a "changed" style prop.
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

  interface Overlay {
    key: keyof VisibilityState;
    label: string;
    svg: string;
    children?: { key: keyof VisibilityState; label: string; svg: string }[];
  }

  const SVG_AIS    = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 2L17 17H3L10 2Z" fill="currentColor"/></svg>`;
  const SVG_TRACKS = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 2L15 10H5L10 2Z" fill="currentColor"/><circle cx="10" cy="13" r="1.3" fill="currentColor" opacity=".65"/><circle cx="9.5" cy="16.5" r="1" fill="currentColor" opacity=".38"/></svg>`;
  const SVG_COG    = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 11L14.5 18.5H5.5L10 11Z" fill="currentColor"/><line x1="10" y1="11" x2="10" y2="2" stroke="currentColor" stroke-width="1.8"/><path d="M7 5L10 2L13 5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  const SVG_TRACK  = `<svg viewBox="0 0 20 20" fill="none"><circle cx="15.5" cy="4.5" r="2.5" fill="currentColor"/><circle cx="15.5" cy="4.5" r="4.5" stroke="currentColor" stroke-width="1" opacity=".3"/><path d="M14 7L11.5 9.5L13.5 12L10.5 14.5L12.5 17.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.5 2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const SVG_ROUTES = `<svg viewBox="0 0 20 20" fill="none"><path d="M3 17L11 7L18 13" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.5 2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="3" cy="17" r="2" fill="currentColor"/><circle cx="11" cy="7" r="2" fill="currentColor"/><circle cx="18" cy="13" r="2" fill="currentColor"/></svg>`;
  const SVG_WAYPTS = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 1.5C7 1.5 4.5 4 4.5 7C4.5 11.5 10 18.5 10 18.5S15.5 11.5 15.5 7C15.5 4 13 1.5 10 1.5Z" fill="currentColor"/><circle cx="10" cy="7" r="2.3" fill="#1e1e2e"/></svg>`;
  const SVG_GLOBE = `<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><ellipse cx="10" cy="10" rx="4" ry="8" stroke="currentColor" stroke-width="1" opacity=".7"/><line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" stroke-width="1" opacity=".7"/></svg>`;
  const SVG_FLAT  = `<svg viewBox="0 0 20 20" fill="none"><rect x="2" y="4" width="16" height="12" rx="1" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" stroke-width="0.8" opacity=".7"/><line x1="8" y1="4" x2="8" y2="16" stroke="currentColor" stroke-width="0.8" opacity=".7"/><line x1="14" y1="4" x2="14" y2="16" stroke="currentColor" stroke-width="0.8" opacity=".7"/></svg>`;

  const OVERLAYS: Overlay[] = [
    {
      key:      'aisVessels',
      label:    'AIS',
      svg:      SVG_AIS,
      children: [
        { key: 'aisTracks',     label: 'Tracks', svg: SVG_TRACKS },
        { key: 'aisPredictors', label: 'COG',    svg: SVG_COG   },
      ],
    },
    { key: 'ownTrack',  label: 'Track',  svg: SVG_TRACK  },
    { key: 'routes',    label: 'Routes', svg: SVG_ROUTES },
    { key: 'waypoints', label: 'Waypts', svg: SVG_WAYPTS },
  ];

  // Items in the global LRU grid.  WMTS charts are flattened into individual
  // layer entries so each layer competes independently in the global sort.
  type GridItem =
    | { kind: 'base';             id: string; layer: BaseLayer }
    | { kind: 'chart';            id: string; chart: Chart }
    | { kind: 'wmts';             id: string; chartId: string; chart: Chart; wmtsLayer: WmtsLayerInfo }
    | { kind: 'wmts-placeholder'; id: string; chart: Chart };

  const sortedItems: GridItem[] = $derived(
    (() => {
      const items: GridItem[] = BASE_LAYERS.map(l => ({ kind: 'base', id: l.id, layer: l }));
      if (!charts.loading && !charts.error) {
        for (const [cid, chart] of Object.entries(charts.available)) {
          if (chart.type !== 'WMTS') {
            items.push({ kind: 'chart', id: cid, chart });
          } else {
            const layers = charts.visibleLayers(cid);
            if (layers.length === 0) {
              items.push({ kind: 'wmts-placeholder', id: cid, chart });
            } else {
              for (const wmtsLayer of layers) {
                items.push({ kind: 'wmts', id: `${cid}:${wmtsLayer.id}`, chartId: cid, chart, wmtsLayer });
              }
            }
          }
        }
      }
      return items.sort((a, b) => chartLru.rank(b.id) - chartLru.rank(a.id));
    })()
  );
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

    <div class="sheet-scroll" bind:this={_scrollEl}>
      <!-- ── Overlay chips ──────────────────────────────────── -->
      <div class="overlay-section">
        <div class="overlay-row">
          {#each OVERLAYS as item (item.key)}
            {#if item.children}
              {@const parentOn = visibility[item.key]}
              <div class="ais-group" class:ais-group--on={parentOn}>
                <button
                  class="ov-chip ov-chip--parent"
                  class:ov-chip--on={parentOn}
                  aria-pressed={parentOn}
                  aria-label="AIS vessels: {parentOn ? 'visible' : 'hidden'}"
                  onclick={() => { visibility.toggle(item.key); }}
                >
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -- hardcoded SVG, not user input -->
                  {@html item.svg}
                  <span class="ov-label">{item.label}</span>
                </button>
                <div class="ais-children" class:ais-children--inactive={!parentOn}>
                  {#each item.children as child (child.key)}
                    {@const on = parentOn && visibility[child.key]}
                    <button
                      class="ov-chip"
                      class:ov-chip--on={on}
                      aria-pressed={on}
                      aria-disabled={!parentOn}
                      aria-label="{child.label}: {on ? 'visible' : 'hidden'}"
                      onclick={() => { if (visibility[item.key]) visibility.toggle(child.key); }}
                    >
                      <!-- eslint-disable-next-line svelte/no-at-html-tags -- hardcoded SVG, not user input -->
                      {@html child.svg}
                      <span class="ov-label">{child.label}</span>
                    </button>
                  {/each}
                </div>
              </div>
            {:else}
              {@const on = visibility[item.key]}
              <button
                class="ov-chip"
                class:ov-chip--on={on}
                aria-pressed={on}
                aria-label="{item.label}: {on ? 'visible' : 'hidden'}"
                onclick={() => { visibility.toggle(item.key); }}
              >
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- hardcoded SVG, not user input -->
                {@html item.svg}
                <span class="ov-label">{item.label}</span>
              </button>
            {/if}
          {/each}
          <div class="proj-group">
            <button
              class="ov-chip"
              class:ov-chip--on={mapView.projection === 'globe'}
              aria-pressed={mapView.projection === 'globe'}
              aria-label="Globe projection"
              onclick={() => { if (mapView.projection !== 'globe') onToggleProjection?.(); }}
            >
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- hardcoded SVG, not user input -->
              {@html SVG_GLOBE}
              <span class="ov-label">Globe</span>
            </button>
            <button
              class="ov-chip"
              class:ov-chip--on={mapView.projection === 'mercator'}
              aria-pressed={mapView.projection === 'mercator'}
              aria-label="Flat (Mercator) projection"
              onclick={() => { if (mapView.projection !== 'mercator') onToggleProjection?.(); }}
            >
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- hardcoded SVG, not user input -->
              {@html SVG_FLAT}
              <span class="ov-label">Flat</span>
            </button>
          </div>
        </div>
      </div>
      <div class="charts-label">Charts</div>
      <div class="grid">

        {#each sortedItems as item (`${item.kind}:${item.id}`)}
          {#if item.kind === 'base'}
            <button
              class="card"
              class:selected={baseLayers.enabled.has(item.id)}
              aria-pressed={baseLayers.enabled.has(item.id)}
              onclick={() => { charts.deselectAll(); baseLayers.toggle(item.id); close(); }}
            >
              <div class="card-preview">
                <LazyMapThumb style={rasterStyle(item.layer.tileUrl)} />
              </div>
              <div class="card-label">{item.layer.name}</div>
            </button>
          {/if}
          {#if item.kind === 'chart'}
            {@const styleUrl = charts.styleUrl(item.chart)}
            {@const tileUrl  = charts.tileUrl(item.chart)}
            {#if styleUrl}
              <!-- Vector / style-based -->
              <button
                class="card"
                class:selected={charts.selected.has(item.id)}
                aria-pressed={charts.selected.has(item.id)}
                onclick={() => { baseLayers.deselectAll(); charts.toggle(item.id); close(); }}
              >
                <div class="card-preview">
                  <LazyMapThumb style={styleUrl} bounds={item.chart.bounds} />
                </div>
                <div class="card-label">{item.chart.name}</div>
              </button>
            {:else}
              <!-- Raster tile chart (tilelayer, WMS, pbf …) -->
              <button
                class="card"
                class:selected={charts.selected.has(item.id)}
                aria-pressed={charts.selected.has(item.id)}
                onclick={() => { baseLayers.deselectAll(); charts.toggle(item.id); close(); }}
              >
                <div class="card-preview">
                  {#if tileUrl}
                    <LazyMapThumb style={rasterStyle(tileUrl)} bounds={item.chart.bounds} />
                  {/if}
                </div>
                <div class="card-label">{item.chart.name}</div>
              </button>
            {/if}
          {/if}
          {#if item.kind === 'wmts'}
            {@const isActive = charts.selected.has(item.chartId) && charts.getLayerSel(item.chartId) === item.wmtsLayer.id}
            <button
              class="card"
              class:selected={isActive}
              aria-pressed={isActive}
              onclick={() => { clickWmts(item.chartId, item.wmtsLayer.id, item.wmtsLayer.tileUrl); close(); }}
            >
              <div class="card-preview">
                {#if item.wmtsLayer.tileUrl}
                  <LazyMapThumb style={rasterStyle(item.wmtsLayer.tileUrl)} bounds={item.chart.bounds} />
                {:else}
                  <div class="card-preview--pulse" style="width:100%;height:100%"></div>
                {/if}
              </div>
              <div class="card-label">{item.chart.name}</div>
              <div class="card-sub">{item.wmtsLayer.title}</div>
            </button>
          {/if}
          {#if item.kind === 'wmts-placeholder'}
            {#if charts.wmtsResolving.has(item.id)}
              <div class="card card--ghost">
                <div class="card-preview card-preview--pulse"></div>
                <div class="card-label">{item.chart.name}</div>
                <div class="card-sub">Loading layers…</div>
              </div>
            {:else}
              <div class="card card--disabled">
                <div class="card-preview"></div>
                <div class="card-label">{item.chart.name}</div>
                <div class="card-sub">
                  {charts.wmtsFailed.has(item.id) ? 'Failed to load' : 'No layers'}
                </div>
              </div>
            {/if}
          {/if}
        {/each}

        <!-- Loading / error placeholder sits after sorted items -->
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

  /* ── Overlay chips ─────────────────────────────────────────────────── */
  .overlay-section {
    padding: 10px 16px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }


  .overlay-row {
    display: flex;
    gap: 6px;
  }

  .ov-chip {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 8px 4px 7px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.38);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
    min-width: 0;
    line-height: 1;
  }

  .ov-chip :global(svg) {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }

  .ov-chip:hover:not(.ov-chip--on) {
    border-color: rgba(255, 255, 255, 0.22);
    color: rgba(255, 255, 255, 0.65);
    background: rgba(255, 255, 255, 0.08);
  }

  .ov-chip--on {
    background: rgba(76, 201, 240, 0.14);
    border-color: rgba(76, 201, 240, 0.45);
    color: #4cc9f0;
  }

  .ov-chip--on:hover {
    background: rgba(76, 201, 240, 0.24);
    border-color: rgba(76, 201, 240, 0.6);
  }


  .ov-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  /* ── Projection group ───────────────────────────────────────────────── */
  .proj-group {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    padding: 3px;
  }

  .proj-group .ov-chip {
    flex: 1;
    border: none;
    border-radius: 8px;
    background: transparent;
  }

  .proj-group .ov-chip--on {
    background: rgba(76, 201, 240, 0.2);
  }

  .proj-group .ov-chip:hover:not(.ov-chip--on) {
    border: none;
    background: rgba(255, 255, 255, 0.09);
    color: rgba(255, 255, 255, 0.65);
  }

  .proj-group .ov-chip--on:hover {
    background: rgba(76, 201, 240, 0.28);
  }

  /* ── AIS group ──────────────────────────────────────────────────────── */
  .ais-group {
    flex: 2;
    display: flex;
    flex-direction: column;
    gap: 3px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    padding: 3px;
    transition: border-color 0.15s, background 0.15s;
  }

  .ais-group--on {
    border-color: rgba(76, 201, 240, 0.45);
    background: rgba(76, 201, 240, 0.04);
  }

  /* Parent button — row layout (icon + label side-by-side) */
  .ov-chip--parent {
    flex-direction: row;
    justify-content: center;
    gap: 7px;
    padding: 7px 8px;
  }

  /* Chips inside group: no individual border; group border owns the frame */
  .ais-group .ov-chip {
    border: none;
    border-radius: 8px;
    background: transparent;
  }

  .ais-group .ov-chip--on {
    background: rgba(76, 201, 240, 0.2);
  }

  .ais-group .ov-chip:hover:not(.ov-chip--on) {
    border: none;
    background: rgba(255, 255, 255, 0.09);
    color: rgba(255, 255, 255, 0.65);
  }

  .ais-group .ov-chip--on:hover {
    background: rgba(76, 201, 240, 0.28);
  }

  /* Sub-row of dependent children */
  .ais-children {
    display: flex;
    gap: 2px;
  }

  .ais-children .ov-chip {
    flex: 1;
  }

  /* When AIS parent is off, dim children and block interaction */
  .ais-children--inactive {
    opacity: 0.25;
    pointer-events: none;
  }

  .charts-label {
    padding: 12px 16px 0;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.35);
  }
</style>
