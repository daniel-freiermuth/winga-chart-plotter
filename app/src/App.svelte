<script lang="ts">
  import { onMount } from 'svelte';
  import Map from './components/Map.svelte';
  import { vesselState } from './stores/vessel';

  const SIGNALK_WS = 'ws://192.168.40.73:3000/signalk/v1/stream?subscribe=self';

  let wasmReady = $state(false);
  let connected = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    // Load WASM core
    let parseSignalkDelta: ((state: any, json: string) => any) | null = null;
    let VesselState: any = null;

    try {
      const wasm = await import('./wasm/signalk_chart_core.js');
      await wasm.default(); // init
      parseSignalkDelta = wasm.parse_signalk_delta;
      VesselState = wasm.VesselState;
      wasmReady = true;
    } catch (e) {
      error = `WASM load failed: ${e}`;
      return;
    }

    // Connect to Signal K
    let state = new VesselState();
    const ws = new WebSocket(SIGNALK_WS);

    ws.addEventListener('open', () => { connected = true; });
    ws.addEventListener('close', () => { connected = false; });
    ws.addEventListener('error', () => { error = 'WebSocket error'; });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (!parseSignalkDelta) return;
      try {
        state = parseSignalkDelta(state, event.data);
        if (state.position) {
          vesselState.set({
            position: { longitude: state.position.longitude, latitude: state.position.latitude },
            cog: state.cog ?? null,
            sog: state.sog ?? null,
            heading: state.heading ?? null,
          });
        }
      } catch {
        // Silently ignore non-delta messages (hello, etc.)
      }
    });

    return () => ws.close();
  });
</script>

<div style="position: relative; width: 100%; height: 100%;">
  <Map />

  <!-- Status overlay -->
  <div style="
    position: absolute; top: 10px; left: 10px; z-index: 10;
    background: rgba(0,0,0,0.7); color: white;
    padding: 6px 12px; border-radius: 6px; font: 12px monospace;
    display: flex; gap: 8px; align-items: center;
  ">
    <span style="color: {wasmReady ? '#4ade80' : '#f87171'}">
      ⬟ WASM
    </span>
    <span style="color: {connected ? '#4ade80' : '#f87171'}">
      ● Signal K
    </span>
    {#if error}
      <span style="color: #f87171">⚠ {error}</span>
    {/if}
  </div>
</div>
