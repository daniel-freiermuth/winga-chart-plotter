<script lang="ts">
  import { onMount } from 'svelte';
  import Map from './components/Map.svelte';
  import Settings from './components/Settings.svelte';
  import { vesselState } from './stores/vessel';
  import { settings } from './stores/settings.svelte';

  let wasm = $state<any>(null);
  let connected = $state(false);
  let error = $state<string | null>(null);
  let client: any;

  onMount(async () => {
    try {
      const mod = await import('./wasm/signalk_chart_core.js');
      await mod.default();
      wasm = mod;
    } catch (e) {
      error = `WASM load failed: ${e}`;
    }
    return () => client?.close();
  });

  // Reconnect whenever WASM is ready or the URL actually changes
  let lastUrl = '';
  $effect(() => {
    if (!wasm) return;
    const url = settings.signalkUrl;
    if (url === lastUrl) return;
    lastUrl = url;
    client?.close();
    connected = false;
    error = null;
    try {
      client = new wasm.SignalKClient(
        url,
        (state: any) => {
          if (state?.position) {
            vesselState.set({
              position: { longitude: state.position.longitude, latitude: state.position.latitude },
              cog: state.cog ?? null,
              sog: state.sog ?? null,
              heading: state.heading ?? null,
            });
          }
        },
        (status: number) => {
          connected = status === 1;
          if (status === 3) error = 'Connection error';
          if (status === 2) error = null;
        },
      );
    } catch (e) {
      error = `Signal K client failed: ${e}`;
      console.error('[signalk] client creation failed', e);
    }
  });
</script>

<div style="position: relative; width: 100%; height: 100%;">
  <Map />
  <Settings />

  <div style="
    position: absolute; top: 10px; left: 10px; z-index: 10;
    background: rgba(0,0,0,0.7); color: white;
    padding: 6px 12px; border-radius: 6px; font: 12px monospace;
    display: flex; gap: 8px; align-items: center;
  ">
    <span style="color: {wasm ? '#4ade80' : '#f87171'}">⬟ WASM</span>
    <span style="color: {connected ? '#4ade80' : '#f87171'}">● Signal K</span>
    {#if error}<span style="color: #f87171">⚠ {error}</span>{/if}
  </div>
</div>

