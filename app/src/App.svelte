<script lang="ts">
  import { onMount } from 'svelte';
  import Map from './components/Map.svelte';
  import Settings from './components/Settings.svelte';
  import ChartPicker from './components/ChartPicker.svelte';
  import { vesselState } from './stores/vessel';
  import { settings } from './stores/settings.svelte';
  import { charts } from './stores/charts.svelte';
  import { ais } from './stores/ais.svelte';
  import type { AisTarget } from './stores/ais.svelte';
  import { fetchVesselInfo } from './lib/signalk-api';

  // Message types received from the SignalK worker.
  interface WsState {
    position?: { longitude: number; latitude: number };
    cog?: number; sog?: number; heading?: number;
  }
  type WorkerMsg =
    | { type: 'state';  state: WsState }
    | { type: 'status'; status: number }
    | { type: 'ais';    targets: AisTarget[] }
    | { type: 'error';  message: string };

  let connected = $state(false);
  let error = $state<string | null>(null);
  let worker: Worker | null = null;

  onMount(() => {
    worker = new Worker(
      new URL('./workers/signalk.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const msg = e.data;
      if (msg.type === 'state') {
        const pos = msg.state.position;
        if (pos) {
          vesselState.set({
            position: { longitude: pos.longitude, latitude: pos.latitude },
            cog: msg.state.cog ?? null,
            sog: msg.state.sog ?? null,
            heading: msg.state.heading ?? null,
          });
        }
      } else if (msg.type === 'status') {
        connected = msg.status === 1;
        if (msg.status === 3) error = 'Connection error';
        if (msg.status === 2) error = null;
      } else if (msg.type === 'ais') {
        ais.update(msg.targets);
      } else {
        error = `Signal K client failed: ${msg.message}`;
        console.error('[signalk] worker error', msg.message);
      }
    };
    return () => {
      worker?.postMessage({ type: 'disconnect' });
      worker?.terminate();
    };
  });

  // Charts and vessel info only depend on the HTTP URL — no WASM needed on main thread.
  let lastHttpUrl = '';
  $effect(() => {
    const httpUrl = settings.signalkHttpUrl;
    if (httpUrl === lastHttpUrl) return;
    lastHttpUrl = httpUrl;
    void charts.load(httpUrl);
    void fetchVesselInfo(httpUrl).then(info => ais.setInfoCache(info));
  });

  let lastUrl = '';
  $effect(() => {
    const url = settings.signalkUrl;
    if (url === lastUrl) return;
    lastUrl = url;
    connected = false;
    error = null;
    worker?.postMessage({ type: 'connect', url });
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
    <span style="color: {connected ? '#4ade80' : '#f87171'}">● Signal K</span>
    {#if error}<span style="color: #f87171">⚠ {error}</span>{/if}
  </div>
</div>

