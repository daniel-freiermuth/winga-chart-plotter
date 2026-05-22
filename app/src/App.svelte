<script lang="ts">
  import { onMount } from 'svelte';
  import Map from './components/Map.svelte';
  import { vesselState } from './stores/vessel';

  const SIGNALK_WS = 'ws://192.168.40.73:3000/signalk/v1/stream?subscribe=self';

  let wasmReady = $state(false);
  let connected = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    let wasm: any;
    try {
      wasm = await import('./wasm/signalk_chart_core.js');
      await wasm.default();
      wasmReady = true;
    } catch (e) {
      error = `WASM load failed: ${e}`;
      return;
    }

    const client = new wasm.SignalKClient(
      SIGNALK_WS,
      // on_state_change: Rust calls this when navigation state updates
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
      // on_status_change: Rust calls this on connection events
      (status: number) => {
        // ConnectionStatus enum: 0=Connecting, 1=Connected, 2=Disconnected, 3=Error
        connected = status === 1;
        if (status === 3) error = 'Connection error';
        if (status === 2) error = null;
      },
    );

    return () => client.close();
  });
</script>

<div style="position: relative; width: 100%; height: 100%;">
  <Map />

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

