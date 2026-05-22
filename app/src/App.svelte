<script lang="ts">
  import { onMount } from 'svelte';
  import Map from './components/Map.svelte';
  import Settings from './components/Settings.svelte';
  import ChartPicker from './components/ChartPicker.svelte';
  import { vesselState } from './stores/vessel';
  import { settings } from './stores/settings.svelte';
  import { charts } from './stores/charts.svelte';
  import type { SignalKClient, VesselState } from './wasm/signalk_chart_core';
  import __wbg_init, { SignalKClient as SKClient } from './wasm/signalk_chart_core.js';

  let wasmReady = $state(false);
  let connected = $state(false);
  let error = $state<string | null>(null);
  let client: SignalKClient | null = null;

  onMount(() => {
    void (async () => {
      try {
        await __wbg_init();
        wasmReady = true;
      } catch (e) {
        error = `WASM load failed: ${String(e)}`;
      }
    })();
    return () => client?.close();
  });

  let lastUrl = '';
  $effect(() => {
    if (!wasmReady) return;
    const url = settings.signalkUrl;
    if (url === lastUrl) return;
    lastUrl = url;
    client?.close();
    connected = false;
    error = null;
    try {
      client = new SKClient(
        url,
        (state: VesselState) => {
          const pos = state.position;
          if (pos) {
            vesselState.set({
              position: { longitude: pos.longitude, latitude: pos.latitude },
              cog: state.cog ?? null,
              sog: state.sog ?? null,
              heading: state.heading ?? null,
            });
          }
        },
        (status: number) => {
          connected = status === 1;
          if (status === 1) void charts.load(settings.signalkHttpUrl);
          if (status === 3) error = 'Connection error';
          if (status === 2) error = null;
        },
      );
    } catch (e) {
      error = `Signal K client failed: ${String(e)}`;
      console.error('[signalk] client creation failed', e);
    }
  });
</script>

<div style="position: relative; width: 100%; height: 100%;">
  <Map />
  <Settings />
  <ChartPicker />

  <div style="
    position: absolute; top: 10px; left: 10px; z-index: 10;
    background: rgba(0,0,0,0.7); color: white;
    padding: 6px 12px; border-radius: 6px; font: 12px monospace;
    display: flex; gap: 8px; align-items: center;
  ">
    <span style="color: {wasmReady ? '#4ade80' : '#f87171'}">⬟ WASM</span>
    <span style="color: {connected ? '#4ade80' : '#f87171'}">● Signal K</span>
    {#if error}<span style="color: #f87171">⚠ {error}</span>{/if}
  </div>
</div>

