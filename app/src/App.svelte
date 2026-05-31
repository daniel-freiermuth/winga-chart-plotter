<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Map from './components/Map.svelte';
  import FaIcon from './lib/FaIcon.svelte';
  import { faLocationCrosshairs, faRuler, faPencil } from '@fortawesome/free-solid-svg-icons';
  import { routePlanner } from './stores/routePlanner.svelte';
  import { saveRoute } from './lib/signalk-api';

  let plannerRouteName = $state('');
  let plannerSaving = $state(false);
  let plannerDiscardConfirm = $state(false);

  // Clear name and confirmation state whenever planner activates.
  $effect(() => {
    if (routePlanner.active) {
      plannerRouteName = '';
      plannerDiscardConfirm = false;
    }
  });

  function handleDiscard() {
    if (plannerRouteName.trim()) {
      plannerDiscardConfirm = true;
    } else {
      routePlanner.exit();
    }
  }

  async function handleSaveRoute() {
    if (!plannerRouteName.trim()) return;
    plannerSaving = true;
    try {
      await saveRoute(settings.signalkHttpUrl, plannerRouteName.trim(), routePlanner.waypoints.map(w => [w.lon, w.lat]), auth.authHeaders);
      routePlanner.exit();
      plannerRouteName = '';
    } catch (e) {
      console.error('[planner] Failed to save route:', e);
    } finally {
      plannerSaving = false;
    }
  }
  import Settings from './components/Settings.svelte';
  import ChartPicker from './components/ChartPicker.svelte';
  import { vesselState } from './stores/vessel';
  import { settings } from './stores/settings.svelte';
  import { followMode } from './stores/follow.svelte';
  import { charts } from './stores/charts.svelte';
  import { ais } from './stores/ais.svelte';
  import { fetchVesselInfo } from './lib/signalk-api';
  import { acquireWakeLock, releaseWakeLock } from './lib/wakeLock';
  import { route } from './stores/route.svelte';
  import { track } from './stores/track.svelte';
  import { routes } from './stores/routes.svelte';
  import { auth } from './stores/auth.svelte';

  // Message types received from the SignalK worker.
  interface WsState {
    position?: { longitude: number; latitude: number };
    cog?: number; sog?: number; heading?: number;
    course?: { nextPoint?: { longitude: number; latitude: number }; previousPoint?: { longitude: number; latitude: number }; activeRoute?: { href: string; name?: string; pointIndex: number; reverse: boolean } };
  }
  interface AisColdData { id: string; name?: string; mmsi?: string; }
  type WorkerMsg =
    | { type: 'state';  state: WsState }
    | { type: 'status'; status: number }
    | { type: 'ais';    hot: ArrayBuffer; ids: string[]; cold: AisColdData[] }
    | { type: 'error';  message: string };

  let mapComp = $state<ReturnType<typeof Map> | null>(null);
  let settingsComp = $state<ReturnType<typeof Settings> | null>(null);
  let connected = $state(false);
  let error = $state<string | null>(null);
  let worker: Worker | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 2000; // ms, doubles on each failure up to 30s

  // Latest compass heading from DeviceOrientation API, shared between the two effects below.
  let latestCompassHeadingRad: number | null = null;

  $effect(() => {
    if (!settings.useGeoLocation || !('geolocation' in navigator)) return;

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const { longitude, latitude, speed, heading, accuracy } = pos.coords;
        settings.setGeoAccuracy(accuracy);
        vesselState.set({
          position: { longitude, latitude },
          // Geolocation heading is in degrees true [0, 360), undefined when stationary.
          // Convert to radians, fall back to null so predictors are hidden when still.
          cog: heading !== null && isFinite(heading) ? heading * (Math.PI / 180) : null,
          sog: speed !== null && isFinite(speed) ? speed : null,
          // Include latest compass heading so the vessel icon rotates.
          heading: latestCompassHeadingRad,
        });
      },
      (err) => {
        console.warn('[geolocation] error', err.code, err.message);
        settings.setGeoAccuracy(null);
        if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
          settings.setGeoError('Location access denied — check browser/OS permissions');
          settings.apply({ useGeoLocation: false });
        } else if (err.code === GeolocationPositionError.POSITION_UNAVAILABLE) {
          settings.setGeoError('Location unavailable — GPS signal lost');
        } else {
          settings.setGeoError(`Location error: ${err.message}`);
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
    );

    return () => {
      navigator.geolocation.clearWatch(id);
      settings.setGeoAccuracy(null);
      latestCompassHeadingRad = null;
    };
  });

  // Subscribe to the device compass (DeviceOrientation API) when browser geo is active.
  // - Chrome/Android/Firefox: 'deviceorientationabsolute' with alpha (CCW from true north)
  // - iOS Safari:             'deviceorientation' with webkitCompassHeading (CW from north)
  $effect(() => {
    if (!settings.useGeoLocation || !('DeviceOrientationEvent' in window)) return;

    // Once an absolute event fires we ignore the relative fallback.
    let gotAbsolute = false;
    // rAF coalescing: only flush one store update per animation frame.
    let rafPending = false;

    function headingFromAlpha(alpha: number): number {
      // alpha is a CCW rotation from geographic north; flip to CW compass bearing.
      return ((360 - alpha) % 360) * (Math.PI / 180);
    }

    function scheduleFlush() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        vesselState.update(s => ({ ...s, heading: latestCompassHeadingRad }));
      });
    }

    function onAbsolute(e: DeviceOrientationEvent) {
      if (e.alpha === null) return;
      gotAbsolute = true;
      latestCompassHeadingRad = headingFromAlpha(e.alpha);
      scheduleFlush();
    }

    function onRelative(e: DeviceOrientationEvent) {
      if (gotAbsolute) return; // prefer absolute events when available
      // iOS: webkitCompassHeading is already a CW bearing from true north.
      const webkit = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
      if (typeof webkit === 'number' && isFinite(webkit)) {
        latestCompassHeadingRad = webkit * (Math.PI / 180);
      } else if (e.absolute && e.alpha !== null) {
        latestCompassHeadingRad = headingFromAlpha(e.alpha);
      } else {
        return;
      }
      scheduleFlush();
    }

    window.addEventListener('deviceorientationabsolute', onAbsolute as EventListener);
    window.addEventListener('deviceorientation', onRelative);

    return () => {
      window.removeEventListener('deviceorientationabsolute', onAbsolute as EventListener);
      window.removeEventListener('deviceorientation', onRelative);
      latestCompassHeadingRad = null;
      vesselState.update(s => ({ ...s, heading: null }));
    };
  });

  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const url = settings.signalkUrl;
      if (url) worker?.postMessage({ type: 'connect', url });
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  }

  onMount(() => {
    acquireWakeLock();
    worker = new Worker(
      new URL('./workers/signalk.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      const msg = e.data;
      if (msg.type === 'state') {
        const pos = msg.state.position;
        if (settings.useGeoLocation) {
          // Geo mode: browser provides position/heading; SK course data is still used.
        } else if (pos) {
          vesselState.set({
            position: { longitude: pos.longitude, latitude: pos.latitude },
            cog: msg.state.cog ?? null,
            sog: msg.state.sog ?? null,
            heading: msg.state.heading ?? null,
            course: msg.state.course,
          });
        }
        // Update course/route regardless of geo mode — route is always from SK.
        route.update(settings.signalkHttpUrl, settings.useGeoLocation ? undefined : msg.state.course);
      } else if (msg.type === 'status') {
        connected = msg.status === 1;
        if (msg.status === 1) {
          // Successfully connected — reset backoff.
          reconnectDelay = 2000;
          // Retry chart list if it failed to load initially (server may not have been
          // ready when we first tried, but the WS connection succeeding means it's up now).
          if (charts.error || Object.keys(charts.available).length === 0) {
            void charts.load(settings.signalkHttpUrl);
          }
        } else if (msg.status === 2 || msg.status === 3) {
          // Disconnected or error — schedule reconnect.
          if (msg.status === 3) error = 'Connection error';
          scheduleReconnect();
        }
        if (msg.status === 2) error = null;
      } else if (msg.type === 'ais') {
        ais.updateBinary(msg.hot, msg.ids, msg.cold);
      } else {
        error = `Signal K client failed: ${msg.message}`;
        console.error('[signalk] worker error', msg.message);
      }
    };

    // Reconnect immediately when the user returns to the page after backgrounding.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !connected) {
        if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        const url = settings.signalkUrl;
        if (url) worker?.postMessage({ type: 'connect', url });
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      worker?.postMessage({ type: 'disconnect' });
      worker?.terminate();
    };
  });

  onDestroy(() => releaseWakeLock());

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
    void routes.load(httpUrl);
    void auth.init(httpUrl);

    if (vesselInfoTimer !== null) clearInterval(vesselInfoTimer);
    const refresh = () => void fetchVesselInfo(httpUrl).then(info => ais.setInfoCache(info));
    refresh();
    vesselInfoTimer = setInterval(refresh, VESSEL_INFO_INTERVAL_MS);
    return () => { if (vesselInfoTimer !== null) clearInterval(vesselInfoTimer); };
  });

  // Track history: re-init whenever the server URL or the history duration changes.
  // Debounced so dragging the logarithmic slider doesn't fire a fetch on every tick.
  let trackReinitTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const httpUrl = settings.signalkHttpUrl;
    const hours   = settings.appearance.track.historyHours;
    if (trackReinitTimer !== null) clearTimeout(trackReinitTimer);
    trackReinitTimer = setTimeout(() => {
      void track.init(httpUrl, hours);
      trackReinitTimer = null;
    }, 400);
    return () => { if (trackReinitTimer !== null) { clearTimeout(trackReinitTimer); trackReinitTimer = null; } };
  });

  let lastUrl = '';
  $effect(() => {
    const url = settings.signalkUrl;
    if (url === lastUrl) return;
    lastUrl = url;
    connected = false;
    error = null;
    reconnectDelay = 2000;
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    worker?.postMessage({ type: 'connect', url });
  });
</script>

<div style="position: relative; width: 100%; height: 100%;">
  <Map bind:this={mapComp} openSettings={(tab) => settingsComp?.openTo(tab as Parameters<typeof settingsComp.openTo>[0])} />
  <Settings bind:this={settingsComp} />
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

  <button
    title="Add ruler"
    onclick={() => mapComp?.addRuler()}
    style="
      position: absolute; top: 158px; left: 10px; z-index: 10;
      background: rgba(0,0,0,0.7); border: 1px solid transparent; color: white;
      padding: 6px 10px; border-radius: 6px; cursor: pointer;
      font-size: 16px;
    "
  ><FaIcon icon={faRuler} /></button>

  <!-- Route planner toggle button -->
  <button
    title={routePlanner.active ? 'Exit route planner' : 'Route planner / measurement'}
    onclick={() => routePlanner.toggle()}
    style="
      position: absolute; top: 325px; left: 10px; z-index: 10;
      background: {routePlanner.active ? 'rgba(100,200,255,0.9)' : 'rgba(0,0,0,0.7)'};
      border: none; color: {routePlanner.active ? '#0a1a2e' : 'white'};
      padding: 6px 10px; border-radius: 6px; cursor: pointer;
      font-size: 16px; transition: background 0.15s, color 0.15s;
    "
  ><FaIcon icon={faPencil} /></button>

  <!-- Route planner HUD -->
  {#if routePlanner.active && routePlanner.waypoints.length > 0}
    <div style="
      position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%);
      z-index: 20; background: rgba(0,0,0,0.82); color: white;
      border-radius: 10px; padding: 12px 16px; min-width: 260px; max-width: 380px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      display: flex; flex-direction: column; gap: 10px;
      font-size: 14px;
    ">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <span style="color: #64c8ff; font-weight: 600; font-size: 15px;">
          {routePlanner.totalDistanceNm.toFixed(2)} NM
        </span>
        <span style="color: #aaa; font-size: 13px;">
          {routePlanner.waypoints.length} waypoint{routePlanner.waypoints.length !== 1 ? 's' : ''}
        </span>
      </div>

      {#if auth.isLoggedIn}
        <div style="display: flex; gap: 6px; align-items: center;">
          <input
            type="text"
            placeholder="Route name…"
            bind:value={plannerRouteName}
            style="
              flex: 1; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.25);
              border-radius: 6px; color: white; padding: 5px 8px; font-size: 13px; outline: none;
            "
          />
          <button
            title="Save as route"
            disabled={plannerSaving || !plannerRouteName.trim()}
            onclick={handleSaveRoute}
            style="
              background: rgba(100,200,100,0.8); border: none; outline: none; color: white;
              padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 13px;
              opacity: {plannerSaving || !plannerRouteName.trim() ? 0.4 : 1};
            "
          >{plannerSaving ? '…' : 'Save'}</button>
        </div>
      {/if}

      {#if plannerDiscardConfirm}
        <div style="background: rgba(255,80,80,0.15); border: 1px solid rgba(255,80,80,0.4); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 13px; color: #fca5a5;">Discard route and all waypoints?</span>
          <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button
              onclick={() => plannerDiscardConfirm = false}
              style="background: rgba(255,255,255,0.12); border: none; outline: none; color: #ccc;
                     padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;">Cancel</button>
            <button
              onclick={() => { routePlanner.exit(); plannerDiscardConfirm = false; }}
              style="background: rgba(255,80,80,0.7); border: none; outline: none; color: white;
                     padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;">Discard</button>
          </div>
        </div>
      {:else}
        <div style="display: flex; justify-content: flex-end;">
          <button
            onclick={handleDiscard}
            title="Discard and exit route planner"
            style="
              background: rgba(255,255,255,0.12); border: none; outline: none; color: #ccc;
              padding: 5px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;
            ">Discard</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

