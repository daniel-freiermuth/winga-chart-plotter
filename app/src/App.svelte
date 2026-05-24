<script lang="ts">
  import { onMount } from 'svelte';
  import Map from './components/Map.svelte';
  import FaIcon from './lib/FaIcon.svelte';
  import { faLocationCrosshairs } from '@fortawesome/free-solid-svg-icons';
  import Settings from './components/Settings.svelte';
  import ChartPicker from './components/ChartPicker.svelte';
  import { vesselState } from './stores/vessel';
  import { settings } from './stores/settings.svelte';
  import { followMode } from './stores/follow.svelte';
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

  let mapComp = $state<ReturnType<typeof Map> | null>(null);
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
  // Vessel info is re-fetched periodically: AIS static data (name, type, dimensions)
  // is broadcast by vessels every ~6 minutes, so Signal K may not have it at startup.
  const VESSEL_INFO_INTERVAL_MS = 3 * 60 * 1000;
  let lastHttpUrl = '';
  let vesselInfoTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    const httpUrl = settings.signalkHttpUrl;
    if (httpUrl === lastHttpUrl) return;
    lastHttpUrl = httpUrl;
    void charts.load(httpUrl);

    if (vesselInfoTimer !== null) clearInterval(vesselInfoTimer);
    const refresh = () => void fetchVesselInfo(httpUrl).then(info => ais.setInfoCache(info));
    refresh();
    vesselInfoTimer = setInterval(refresh, VESSEL_INFO_INTERVAL_MS);
    return () => { if (vesselInfoTimer !== null) clearInterval(vesselInfoTimer); };
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
  <Map bind:this={mapComp} />
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

  <button
    title={followMode.following ? 'Stop following vessel' : 'Follow vessel'}
    disabled={!$vesselState.position}
    onclick={() => mapComp?.flyToVessel()}
    style="
      position: absolute; top: 120px; left: 10px; z-index: 10;
      background: {followMode.following ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.7)'};
      border: none;
      color: {followMode.following ? '#111827' : 'white'};
      padding: 6px 10px; border-radius: 6px; cursor: pointer;
      font-size: 16px; transition: background 0.15s, color 0.15s;
      opacity: {$vesselState.position ? 1 : 0.35};
    "
  ><FaIcon icon={faLocationCrosshairs} /></button>
</div>

