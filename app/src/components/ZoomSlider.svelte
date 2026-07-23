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

  // Fraction [0..1] of total track length: 0 = track top = min zoom, 1 = bottom = max zoom.
  const thumbFrac = $derived(clamp((zoom - minZoom) / range, 0, 1));

  function applyZoomAt(clientY: number): void {
    if (!map || !trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    const f = clamp((clientY - rect.top) / rect.height, 0, 1);
    map.easeTo({ zoom: minZoom + f * range, duration: 0 });
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
  >
    <!-- Chevrons centred in the visible left half of the 56 px circle (x ≤ 28). -->
    <svg class="zoom-hints" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polyline points="5,26 14,17 23,26" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="5,30 14,39 23,30" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
</div>

<style>
  .zoom-track {
    position: absolute;
    right: 0;
    top: 20px;
    bottom: 104px; /* MOB button: bottom 20px + height 52px = top at 72px; +28px thumb radius +4px gap */
    width: 0;          /* track has no width; thumb overhangs left */
    pointer-events: none;
    z-index: 10;
  }

  .zoom-thumb {
    position: absolute;
    /* right: -28px centres the 56 px circle on the viewport right edge.
       The viewport clips the right semicircle; only the left half is visible.
       This value must equal half the element width (56 / 2 = 28). */
    right: -28px;
    width: 56px;
    height: 56px;
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
  .zoom-hints {
    position: absolute;
    inset: 0;
    pointer-events: none;
    transition: opacity 0.12s;
  }
  .zoom-thumb.dragging .zoom-hints,
  .zoom-thumb:active .zoom-hints {
    opacity: 0.35;
  }
</style>
