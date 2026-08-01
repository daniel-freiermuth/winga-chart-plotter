<script lang="ts">
  import type { StyleSpecification } from 'maplibre-gl';
  import MapThumb from './MapThumb.svelte';
  import type { MapViewStore } from '../stores/mapView.svelte';

  let {
    style,
    bounds,
    view,
  }: {
    style: StyleSpecification | string;
    bounds?: [number, number, number, number] | undefined;
    view: MapViewStore;
  } = $props();

  let container = $state<HTMLDivElement | undefined>();
  let visible   = $state(false);

  // Mount MapThumb only while the card is near the viewport.  A 200 px root
  // margin pre-initialises tiles one card-height before the user scrolls
  // there, hiding the load latency.  Cards that scroll away again are
  // UN-mounted: every mounted MapThumb holds a live WebGL context, browsers
  // cap those at ~16 per page and evict the OLDEST live context when the cap
  // is exceeded — which is the main chart map created at startup.  Keeping
  // only near-viewport thumbs alive bounds the context count; the picker's
  // {#if isOpen} still destroys everything on close.
  $effect(() => {
    const el = container;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Entries are ordered oldest → newest; only the latest state counts.
        const last = entries.at(-1);
        if (last) visible = last.isIntersecting;
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => { observer.disconnect(); };
  });
</script>

<div bind:this={container} class="lazy-thumb">
  {#if visible}
    <MapThumb {style} {bounds} {view} />
  {/if}
</div>

<style>
  .lazy-thumb {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
