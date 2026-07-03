<script lang="ts">
  import type { Map as MaplibreMap } from 'maplibre-gl';

  const {
    map,
    zoom,
    onZoomIn,
    onZoomOut,
  }: {
    map: MaplibreMap | undefined;
    zoom: number;
    onZoomIn: () => void;
    onZoomOut: () => void;
  } = $props();

  let trackEl: HTMLDivElement | undefined = $state();
  let dragging = $state(false);

  const minZoom = $derived(map?.getMinZoom() ?? 0);
  const maxZoom = $derived(map?.getMaxZoom() ?? 22);
  const range   = $derived(maxZoom - minZoom || 1);

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  // Fraction: 0 = track top = max zoom, 1 = track bottom = min zoom
  const thumbFrac = $derived(1 - clamp((zoom - minZoom) / range, 0, 1));

  function applyZoomAt(clientY: number): void {
    if (!map || !trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    const f = clamp((clientY - rect.top) / rect.height, 0, 1);
    map.easeTo({ zoom: minZoom + (1 - f) * range, duration: 0 });
  }

  function onPointerDown(e: PointerEvent): void {
    if (!map || !trackEl) return;
    e.preventDefault();
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    applyZoomAt(e.clientY);
  }

  function onPointerUp(e: PointerEvent): void {
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'ArrowUp'   || e.key === '+') { onZoomIn();  e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === '-') { onZoomOut(); e.preventDefault(); }
  }
</script>

<!-- Zero-width track spanning the full right edge; thumb overhangs to the left. -->
<div class="zoom-track" bind:this={trackEl}>
  <div
    class="zoom-thumb"
    class:dragging
    style="top: {thumbFrac * 100}%"
    role="slider"
    aria-label="Map zoom"
    aria-valuemin={Math.round(minZoom)}
    aria-valuemax={Math.round(maxZoom)}
    aria-valuenow={Math.round(zoom)}
    tabindex="0"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onkeydown={onKeyDown}
  ></div>
</div>

<style>
  .zoom-track {
    position: absolute;
    right: 0;
    top: 20px;
    bottom: 104px;  /* MOB button: bottom 20px + height 52px = top at 72px; +22px thumb radius +10px gap */
    width: 0;          /* track has no width; thumb overhangs left */
    pointer-events: none;
    z-index: 10;
  }

  .zoom-thumb {
    position: absolute;
    /* right: -22px centres the 44 px circle on the viewport right edge.
       The viewport clips the right semicircle; only the left half is visible.
       This value must equal half the element width (44 / 2 = 22). */
    right: -22px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    transform: translateY(-50%);
    background: rgba(0, 0, 0, 0.70);
    border: 1.5px solid rgba(255, 255, 255, 0.18);
    cursor: ns-resize;
    pointer-events: auto;
    touch-action: none;
    user-select: none;
    will-change: top;
    transition: background 0.12s, border-color 0.12s;
  }

  .zoom-thumb.dragging,
  .zoom-thumb:active {
    background: rgba(40, 40, 110, 0.92);
    border-color: rgba(150, 150, 255, 0.45);
  }

  @media (hover: hover) and (pointer: fine) {
    .zoom-thumb:hover {
      background: rgba(30, 30, 80, 0.85);
      border-color: rgba(255, 255, 255, 0.30);
    }
  }
</style>
