<script lang="ts">
  import type { StyleSpecification } from 'maplibre-gl';
  import MapThumb from './MapThumb.svelte';

  let {
    style,
    bounds,
  }: {
    style: StyleSpecification | string;
    bounds?: [number, number, number, number] | undefined;
  } = $props();

  let container = $state<HTMLDivElement | undefined>();
  let visible   = $state(false);

  // Mount MapThumb only once the card enters the viewport.  A 200 px root margin
  // pre-initialises tiles one card-height before the user scrolls there, hiding
  // the load latency.  Once revealed, we never re-hide (prevents flicker on
  // scroll-back and keeps logic simple; the picker's {#if isOpen} destroys
  // everything on close anyway).
  $effect(() => {
    const el = container;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) visible = true;
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => { observer.disconnect(); };
  });
</script>

<div bind:this={container} class="lazy-thumb">
  {#if visible}
    <MapThumb {style} {bounds} />
  {/if}
</div>

<style>
  .lazy-thumb {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
