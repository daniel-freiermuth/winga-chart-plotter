<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Map from './components/Map.svelte';
  import FaIcon from './lib/FaIcon.svelte';
  import {
    faGear, faLayerGroup, faLocationCrosshairs, faRuler,
    faExpand, faCompress,
  } from '@fortawesome/free-solid-svg-icons';
  import { routePlanner } from './stores/routePlanner.svelte';
  import { waypoints } from './stores/waypoints.svelte';
  import { saveRoute, updateRoute, raiseMob } from './lib/wasmRest';

  let plannerSaving = $state(false);
  let plannerDiscardConfirm = $state(false);
  let plannerError = $state<string | null>(null);

  function handleDiscard() {
    if (routePlanner.name.trim()) {
      plannerDiscardConfirm = true;
    } else {
      routePlanner.exit();
    }
  }

  async function handleSaveRoute() {
    if (!routePlanner.name.trim()) return;
    plannerSaving = true;
    plannerError = null;
    try {
      if (routePlanner.editingRouteUuid) {
        await updateRoute(settings.signalkHttpUrl, routePlanner.editingRouteUuid, routePlanner.name.trim(), routePlanner.waypoints, auth.authHeaders);
      } else {
        await saveRoute(settings.signalkHttpUrl, routePlanner.name.trim(), routePlanner.waypoints, auth.authHeaders);
      }
      routePlanner.exit();
      await routes.load(settings.signalkHttpUrl);
    } catch (e) {
      console.error('[planner] Failed to save route:', e);
      plannerError = String(e);
    } finally {
      plannerSaving = false;
    }
  }
  import Settings from './components/Settings.svelte';
  import ChartPicker from './components/ChartPicker.svelte';
  import WidgetPanel from './components/WidgetPanel.svelte';
  import ExtPanel from './components/ExtPanel.svelte';
  import { vesselState } from './stores/vessel';
  import { settings, type SettingsTab } from './stores/settings.svelte';
  import { followMode } from './stores/follow.svelte';
  import { rotateMode } from './stores/rotateMode.svelte';
  import { mapView } from './stores/mapView.svelte';
  import { charts } from './stores/charts.svelte';
  import { ais } from './stores/ais.svelte';
  import { fetchVesselInfo } from './lib/wasmRest';
  import { acquireWakeLock, releaseWakeLock } from './lib/wakeLock';
  import { route } from './stores/route.svelte';
  import { track } from './stores/track.svelte';
  import { routes } from './stores/routes.svelte';
  import { auth } from './stores/auth.svelte';
  import { connection } from './stores/connection.svelte';
  import { plotterExtensions, type ButtonDef } from './stores/plotterExtensions.svelte';
  import { createSkRelay } from './lib/sk-relay';
  import { type MapControl, type PanelControl } from './lib/plotterext-host';

  // Message types received from the SignalK worker.
  interface WsState {
    position?: { longitude: number; latitude: number };
    cog?: number; sog?: number; heading?: number;
    course?: { nextPoint?: { longitude: number; latitude: number }; previousPoint?: { longitude: number; latitude: number }; activeRoute?: { href: string; name?: string; pointIndex: number; reverse: boolean } };
  }
  interface AisColdData { id: string; name?: string; mmsi?: string; skCpa?: { distanceM: number; timeToS: number } | null; }
  type WorkerMsg =
    | { type: 'state';  state: WsState }
    | { type: 'status'; status: number }
    | { type: 'ais';    hot: ArrayBuffer; ids: string[]; cold: AisColdData[] }
    | { type: 'raw';    text: string }
    | { type: 'error';  message: string };

  // Explicit interface matching Map.svelte's exported functions, so TypeScript
  // can fully verify the calls without `eslint-disable` suppression.
  interface MapInstance {
    getView(): { center: [number, number]; zoom: number; bounds: [number, number, number, number] };
    flyTo(position: [number, number], zoom?: number): void;
    fitBounds(bounds: [number, number, number, number]): void;
    flyToVessel(): void;
    addRuler(): void;
    setProjection(proj: string): void;
    toggleFullscreen(): void;
    closePopup(): void;
  }

  let mapComp             = $state<MapInstance | null>(null);
  let settingsComp        = $state<{ open(): void; openTo(t: SettingsTab): void } | null>(null);
  let chartPickerComp     = $state<{ open(): void } | null>(null);
  let chartPickerOpen     = $state(false);
  let worker: Worker | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 2000; // ms, doubles on each failure up to 30s

  // Plotter-extensions relay and control objects
  const relay = createSkRelay((msg) => worker?.postMessage({ type: 'send', msg }));

  const mapControl: MapControl = {
    getView:   ()        => mapComp!.getView(),
    flyTo:     (pos, z)  => { mapComp!.flyTo(pos, z); },
    fitBounds: (b)       => { mapComp!.fitBounds(b); },
  };

  const panelControl: PanelControl = {
    openPanel:        (extId, panelId) => { plotterExtensions.openPanelFor({ extensionId: extId, panelId, isConfig: false }); },
    togglePanel:      (extId, panelId) => { plotterExtensions.togglePanelFor(extId, panelId); },
    closePanel:       ()               => { plotterExtensions.closePanelFor(); },
    openConfigPanel:  (extId, instanceId, widgetId) => {
      const manifest = plotterExtensions.extensions.get(extId);
      const wDef = manifest?.widgets?.find(w => w.id === widgetId);
      if (wDef?.configPanel) {
        plotterExtensions.openPanelFor({ extensionId: extId, panelId: wDef.configPanel, isConfig: true, targetInstance: instanceId, targetWidget: widgetId });
      }
    },
    toggleConfigPanel: (extId, instanceId, widgetId) => {
      const manifest = plotterExtensions.extensions.get(extId);
      const wDef = manifest?.widgets?.find(w => w.id === widgetId);
      if (!wDef?.configPanel) return;
      const cur = plotterExtensions.openPanel;
      if (cur !== null && cur.extensionId === extId && cur.panelId === wDef.configPanel) {
        plotterExtensions.closePanelFor();
      } else {
        plotterExtensions.openPanelFor({ extensionId: extId, panelId: wDef.configPanel, isConfig: true, targetInstance: instanceId, targetWidget: widgetId });
      }
    },
  };

  // Latest compass heading from DeviceOrientation API, shared between the two effects below.
  let latestCompassHeadingRad: number | null = null;

  $effect(() => {
    if (!settings.useGeoLocation || !('geolocation' in navigator)) return;

    let watchId: number | null = null;
    let lastUpdateMs = Date.now();

    function startWatch(): void {
      lastUpdateMs = Date.now();
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          lastUpdateMs = Date.now();
          settings.setGeoError(null);
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
          if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
            settings.setGeoAccuracy(null);
            settings.setGeoError('Location access denied — check browser/OS permissions');
            settings.apply({ useGeoLocation: false });
          } else if (err.code === GeolocationPositionError.TIMEOUT) {
            // Firefox Android can silently stall after a timeout — restart the watch.
            console.warn('[geolocation] timeout, restarting watch');
            if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
            startWatch();
          } else {
            settings.setGeoAccuracy(null);
            settings.setGeoError(
              err.code === GeolocationPositionError.POSITION_UNAVAILABLE
                ? 'Location unavailable — GPS signal lost'
                : `Location error: ${err.message}`,
            );
          }
        },
        // timeout:Infinity avoids spurious TIMEOUT errors between GPS fixes;
        // the watchdog below handles real stalls.
        { enableHighAccuracy: true, maximumAge: 0, timeout: Infinity },
      );
    }

    startWatch();

    // Firefox Android sometimes silently stops the watch without any error callback.
    // Restart if no update has arrived within STALE_MS.
    const STALE_MS = 30_000;
    const watchdog = setInterval(() => {
      if (Date.now() - lastUpdateMs > STALE_MS) {
        console.warn('[geolocation] watchdog: no updates for 30 s, restarting watch');
        if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
        startWatch();
      }
    }, STALE_MS / 2);

    // The browser may suspend the watch when the page is hidden (screen off, tab switch).
    // Re-start as soon as the user returns.
    function onPageVisible(): void {
      if (document.visibilityState === 'visible') {
        if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
        startWatch();
      }
    }
    document.addEventListener('visibilitychange', onPageVisible);

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onPageVisible);
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
    void acquireWakeLock();
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
            ...(msg.state.course !== undefined ? { course: msg.state.course } : {}),
          });
        }
        // Update course/route regardless of geo mode — route is always from SK.
        route.update(settings.signalkHttpUrl, settings.useGeoLocation ? undefined : msg.state.course);
      } else if (msg.type === 'status') {
        connection.setConnected(msg.status === 1);
        if (msg.status === 1) {
          // Successfully connected — reset backoff and re-announce relay subscriptions.
          reconnectDelay = 2000;
          relay.resubscribe();
          // Retry chart list if it failed to load initially (server may not have been
          // ready when we first tried, but the WS connection succeeding means it's up now).
          if (charts.error || Object.keys(charts.available).length === 0) {
            void charts.load(settings.signalkHttpUrl);
          }
        } else if (msg.status === 2 || msg.status === 3) {
          // Disconnected or error — schedule reconnect.
          if (msg.status === 3) connection.setError('Connection error');
          scheduleReconnect();
        }
        if (msg.status === 2) connection.setError(null);
      } else if (msg.type === 'ais') {
        ais.updateBinary(msg.hot, msg.ids, msg.cold);
      } else if (msg.type === 'raw') {
        relay.feed(msg.text);
      } else {
        connection.setError(`Signal K client failed: ${msg.message}`);
        console.error('[signalk] worker error', msg.message);
      }
    };

    // Pause the worker when the tab goes to background so intermediate state
    // updates don't pile up in the main thread's message queue.  On return,
    // resume (which flushes the latest snapshot) then fast-reconnect if needed.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        worker?.postMessage({ type: 'resume' });
        if (!connection.connected) {
          if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          const url = settings.signalkUrl;
          if (url) worker?.postMessage({ type: 'connect', url });
        }
      } else {
        worker?.postMessage({ type: 'pause' });
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

  onDestroy(() => { releaseWakeLock(); });

  // Charts and vessel info only depend on the HTTP URL — no WASM needed on main thread.
  // Vessel info is re-fetched periodically: AIS static data (name, type, dimensions)
  // is broadcast by vessels every ~6 minutes, so Signal K may not have it at startup.
  // Reload routes and waypoints periodically so changes from other UIs are reflected.
  let resourcePollTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    const httpUrl  = settings.signalkHttpUrl;
    const interval = settings.resourcePollIntervalSeconds * 1000;
    if (resourcePollTimer !== null) clearInterval(resourcePollTimer);
    const pollResources = () => {
      void routes.load(httpUrl);
      void waypoints.load(httpUrl);
    };
    resourcePollTimer = setInterval(pollResources, interval);
    return () => { if (resourcePollTimer !== null) clearInterval(resourcePollTimer); };
  });

  const VESSEL_INFO_INTERVAL_MS = 3 * 60 * 1000;
  let lastHttpUrl = '';
  let vesselInfoTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    const httpUrl = settings.signalkHttpUrl;
    if (httpUrl === lastHttpUrl) return;
    lastHttpUrl = httpUrl;
    void charts.load(httpUrl);
    void routes.load(httpUrl);
    void waypoints.load(httpUrl);
    void auth.init(httpUrl);
    void plotterExtensions.load(httpUrl);

    if (vesselInfoTimer !== null) clearInterval(vesselInfoTimer);
    const refresh = () => void fetchVesselInfo(httpUrl)
      .then(info => { ais.setInfoCache(info); })
      .catch((e: unknown) => { console.warn('[vesselInfo] fetch error:', e); });
    refresh();
    vesselInfoTimer = setInterval(refresh, VESSEL_INFO_INTERVAL_MS);
    return () => { if (vesselInfoTimer !== null) clearInterval(vesselInfoTimer); };
  });

  // Track history: re-init only when the server URL or history depth actually changes.
  // No cleanup returned intentionally: a returned cleanup would run before the guard check on
  // every re-run (e.g. when track color changes via bind:value), clearing the timer before we
  // can see the key is unchanged. The timer variable is managed entirely inside the guard.
  let trackReinitTimer: ReturnType<typeof setTimeout> | null = null;
  let _trackReinitKey = '';
  $effect(() => {
    const httpUrl = settings.signalkHttpUrl;
    const hours   = settings.appearance.track.historyHours;
    const key = `${httpUrl}|${String(hours)}`;
    if (key === _trackReinitKey) return;
    _trackReinitKey = key;
    if (trackReinitTimer !== null) clearTimeout(trackReinitTimer);
    trackReinitTimer = setTimeout(() => {
      void track.init(httpUrl, hours);
      trackReinitTimer = null;
    }, 400);
  });

  let lastUrl = '';
  $effect(() => {
    const url = settings.signalkUrl;
    if (url === lastUrl) return;
    lastUrl = url;
    connection.setConnected(false);
    connection.setError(null);
    reconnectDelay = 2000;
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    worker?.postMessage({ type: 'connect', url });
  });

  function handleOpenSettings(tab: SettingsTab): void {
    chartPickerOpen = false;
    settingsComp?.openTo(tab);
  }
  function handleOpenSettingsModal(): void {
    mapComp?.closePopup();
    chartPickerOpen      = false;
    settingsComp?.open();
  }
  function handleOpenChartPicker(): void {
    mapComp?.closePopup();
    chartPickerComp?.open();
  }
  function handleFlyToVessel(): void {
    mapComp?.flyToVessel();
  }
  let _compassPressTimer: ReturnType<typeof setTimeout> | null = null;
  let _compassWasLongPress = false;

  function onCompassPointerDown() {
    _compassWasLongPress = false;
    _compassPressTimer = setTimeout(() => {
      _compassWasLongPress = true;
      _compassPressTimer = null;
      rotateMode.toggleLock();
      if ('vibrate' in navigator) navigator.vibrate(30);
    }, 500);
  }
  function onCompassPointerEnd() {
    if (_compassPressTimer !== null) { clearTimeout(_compassPressTimer); _compassPressTimer = null; }
  }
  function onCompassClick() {
    if (_compassWasLongPress) { _compassWasLongPress = false; return; }
    rotateMode.toggle($vesselState.cog !== null, $vesselState.heading !== null, route.nextPoint !== null);
  }
  function handleAddRuler(): void {
    chartPickerOpen = false;
    mapComp?.addRuler();
  }
  function handleToggleProjection(): void {
    mapComp?.setProjection(mapView.projection === 'mercator' ? 'globe' : 'mercator');
  }
  function handleToggleFullscreen(): void {
    mapComp?.toggleFullscreen();
  }

  async function mobRaise() {
    try {
      await raiseMob(settings.signalkHttpUrl, auth.authHeaders);
    } catch (e) {
      console.error('[mob] raise failed', e);
    }
  }

  function handleExtButton(extensionId: string, btn: ButtonDef): void {
    const { action } = btn;
    if (action.type === 'togglePanel' && action.panel) {
      plotterExtensions.togglePanelFor(extensionId, action.panel);
    } else if (action.type === 'openPanel' && action.panel) {
      plotterExtensions.openPanelFor({ extensionId, panelId: action.panel, isConfig: false });
    }
    // sendMessage not yet implemented (no background runtimes)
  }
</script>

<div style="position: relative; width: 100%; height: 100%;">
  <Map bind:this={mapComp} openSettings={handleOpenSettings} onMapClick={() => { chartPickerOpen = false; }} />
  <Settings bind:this={settingsComp} />
  <ChartPicker bind:this={chartPickerComp} bind:isOpen={chartPickerOpen} onToggleProjection={handleToggleProjection} />
  {#each plotterExtensions.layout as placement (placement.instanceId)}
    {@const manifest = plotterExtensions.extensions.get(placement.extensionId)}
    {@const wDef = manifest?.widgets?.find(w => w.id === placement.widgetId)}
    {#if manifest && wDef}
      <WidgetPanel {placement} widgetDef={wDef} {mapControl} {panelControl} {relay} />
    {/if}
  {/each}
  <ExtPanel {mapControl} {panelControl} {relay} />

  <!-- Consolidated map toolbar -->
  <div class="map-toolbar">
    <button
      class="map-btn"
      title="Settings"
      style="color: {connection.connected ? '#4ade80' : connection.error ? '#f87171' : '#f59e0b'}"
      onclick={handleOpenSettingsModal}
    ><FaIcon icon={faGear} /></button>


    {#each [...plotterExtensions.extensions.entries()] as [extId, manifest] (extId)}
      {#each (manifest.buttons ?? []) as btn (btn.id)}
        {#if btn.slot === 'mapToolbar'}
          {@const op = plotterExtensions.openPanel}
          <button
            class="map-btn"
            class:map-btn--open={op !== null && op.extensionId === extId && !op.isConfig}
            title={btn.title}
            onclick={() => { handleExtButton(extId, btn); }}
          >{btn.icon?.slice(0, 3) ?? '⚙'}</button>
        {/if}
      {/each}
    {/each}


    <div class="map-toolbar-divider"></div>

    <button
      class="map-btn"
      title="{mapView.isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}"
      onclick={handleToggleFullscreen}
    ><FaIcon icon={mapView.isFullscreen ? faCompress : faExpand} /></button>

    <div class="map-toolbar-divider"></div>

    <button
      class="map-btn"
      title="Add ruler"
      onclick={handleAddRuler}
    ><FaIcon icon={faRuler} /></button>
  </div>

  <!-- Route planner HUD -->
  {#if routePlanner.active}
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
            bind:value={routePlanner.name}
            style="
              flex: 1; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.25);
              border-radius: 6px; color: white; padding: 5px 8px; font-size: 13px; outline: none;
            "
          />
          <button
            title={routePlanner.editingRouteUuid ? 'Update route' : 'Save as route'}
            disabled={plannerSaving || !routePlanner.name.trim()}
            onclick={handleSaveRoute}
            style="
              background: rgba(100,200,100,0.8); border: none; outline: none; color: white;
              padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 13px;
              opacity: {plannerSaving || !routePlanner.name.trim() ? 0.4 : 1};
            "
          >{plannerSaving ? '…' : routePlanner.editingRouteUuid ? 'Update' : 'Save'}</button>
        </div>
        {#if plannerError}
          <div style="color: #fca5a5; font-size: 12px;">{plannerError}</div>
        {/if}
      {/if}

      {#if plannerDiscardConfirm}
        <div style="background: rgba(255,80,80,0.15); border: 1px solid rgba(255,80,80,0.4); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 13px; color: #fca5a5;">{routePlanner.editingRouteUuid ? 'Discard changes to this route?' : 'Discard route and all waypoints?'}</span>
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

  <!-- MOB (Man Overboard) button — bottom-right -->
  <div class="mob-container">
    <button class="mob-btn" onclick={() => void mobRaise()} title="Man Overboard — raise alarm">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M12.0166 9.49274C13.5334 9.49274 14.763 8.26315 14.763 6.74637C14.763 5.22959 13.5334 4 12.0166 4C10.4998 4 9.27023 5.22959 9.27023 6.74637C9.27023 8.26315 10.4998 9.49274 12.0166 9.49274Z" fill="currentColor"/>
        <path d="M3.19527 5.01658C3.95467 4.89904 4.66549 5.41932 4.78302 6.17867L5.24894 9.1881L9.23398 10.7149H14.7992L18.7843 9.1881L19.2501 6.17867C19.3676 5.41932 20.0786 4.89904 20.8379 5.01658C21.5973 5.13412 22.1175 5.84498 22 6.60434L21.2919 11.1786L16.6542 12.9795L16.6542 15.4348L16.0165 15.9348C14.7965 16.7848 13.4065 17.2148 12.0165 17.2148C10.6265 17.2148 9.23651 16.7848 8.01651 15.9348L7.37886 15.4348L7.37891 12.9795L2.74124 11.1786L2.03314 6.60434C1.91561 5.84498 2.43588 5.13412 3.19527 5.01658Z" fill="currentColor"/>
        <path d="M12 19.1948C13.39 19.1948 14.78 18.7648 16 17.9148C17.22 18.7648 18.61 19.2348 20 19.2348H22V21.2348H20C18.62 21.2348 17.26 20.8948 16 20.2448C14.74 20.8948 13.37 21.2148 12 21.2148C10.63 21.2148 9.26 20.8848 8 20.2448C6.74 20.8848 5.38 21.2348 4 21.2348H2V19.2348H4C5.39 19.2348 6.78 18.7648 8 17.9148C9.22 18.7648 10.61 19.1948 12 19.1948Z" fill="currentColor"/>
      </svg>
    </button>
  </div>

  <!-- Navigation stack: compass (top) → pin → layers (bottom), bottom-left corner -->
  <div class="nav-stack">
    <!-- Compass: tap cycles auto modes, long-press toggles free rotation -->
    <button
      class="nav-fab compass-fab"
      class:compass-fab--free={rotateMode.mode === 'manual'}
      title={rotateMode.mode === 'manual'
        ? 'Free rotation — tap to re-engage, hold to lock'
        : `Rotation: ${rotateMode.label} — tap to cycle, hold for free`}
      aria-label="Rotation mode: {rotateMode.compassLabel}"
      onpointerdown={onCompassPointerDown}
      onpointerup={onCompassPointerEnd}
      onpointercancel={onCompassPointerEnd}
      onclick={onCompassClick}
    >
      <svg width="52" height="52" viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r="21"
          fill="rgba(0,0,0,0.72)"
          stroke={rotateMode.mode === 'manual' ? '#f59e0b' : 'rgba(255,255,255,0.18)'}
          stroke-width="1.5"/>
        <!-- Rotating needle always points true North; label rotates with it -->
        <g transform="rotate({-mapView.bearing}, 22, 22)">
          <polygon points="22,5 17,23 22,20 27,23" fill="#e53e3e"/>
          <polygon points="22,39 17,21 22,24 27,21" fill="rgba(200,200,200,0.75)"/>
          <circle cx="22" cy="22" r="6" fill="rgba(0,0,0,0.75)"/>
          <text x="22" y="22" text-anchor="middle" dominant-baseline="middle"
            font-size="12" font-family="system-ui,sans-serif" font-weight="700"
            fill={rotateMode.mode === 'manual' ? '#f59e0b' : 'white'}
          >{rotateMode.compassLabel}</text>
        </g>
      </svg>
    </button>

    <!-- Position pin -->
    <button
      class="nav-fab"
      class:nav-fab--active={followMode.following}
      title={followMode.following ? 'Stop following vessel' : 'Follow vessel'}
      disabled={!followMode.following && !$vesselState.position}
      onclick={handleFlyToVessel}
    ><FaIcon icon={faLocationCrosshairs} /></button>

    <!-- Chart &amp; layer picker -->
    <button
      class="nav-fab"
      class:nav-fab--open={chartPickerOpen}
      title="Charts &amp; layers"
      onclick={handleOpenChartPicker}
    ><FaIcon icon={faLayerGroup} /></button>
  </div>
</div>

<style>
  .map-toolbar {
    position: absolute;
    top: 10px;
    left: 10px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .map-btn {
    background: rgba(0,0,0,0.7);
    border: none;
    border-bottom: 2px solid transparent;
    color: white;
    padding: 10px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 16px;
    transition: background 0.15s, color 0.15s;
    min-width: 44px;
    text-align: center;
  }
  @media (hover: hover) and (pointer: fine) {
    .map-btn:hover:not(:disabled)  { background: rgba(40,40,80,0.9); }
  }
  .map-btn:disabled              { opacity: 0.35; cursor: default; }
  .map-btn--open                 { background: rgba(80,100,140,0.85); border-bottom: 2px solid rgba(150,200,255,0.8); }
  @media (hover: hover) and (pointer: fine) {
    .map-btn--open:hover:not(:disabled)  { background: rgba(90,115,160,0.9); }
  }

  .map-toolbar-divider {
    height: 1px;
    background: rgba(255,255,255,0.15);
    margin: 2px 0;
  }

  .nav-stack {
    position: absolute;
    bottom: 20px;
    left: 16px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .nav-fab {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    border: 1.5px solid rgba(255,255,255,0.18);
    background: rgba(0,0,0,0.72);
    color: white;
    font-size: 20px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
    padding: 0;
  }
  .nav-fab:disabled              { opacity: 0.35; cursor: default; }
  .nav-fab--active               { background: rgba(255,255,255,0.9); color: #111827; border-color: rgba(255,255,255,0.9); }
  .nav-fab--open                 { background: rgba(76,201,240,0.15); box-shadow: 0 0 0 2px #4cc9f0, 0 2px 12px rgba(0,0,0,0.45); }
  @media (hover: hover) and (pointer: fine) {
    .nav-fab:hover:not(:disabled)         { background: rgba(40,40,80,0.9); }
    .nav-fab--active:hover:not(:disabled) { background: rgba(220,220,240,0.95); }
    .nav-fab--open:hover                  { background: rgba(76,201,240,0.25); }
  }
  .nav-fab:active:not(:disabled) { transform: scale(0.94); }

  /* Compass FAB: the SVG renders its own circle; the button wrapper is transparent. */
  .compass-fab { background: none; border: none; box-shadow: none; padding: 0; }
  @media (hover: hover) and (pointer: fine) {
    .compass-fab:hover svg { filter: brightness(1.25); }
  }
  .compass-fab:active { transform: scale(0.94); }

  .mob-container {
    position: absolute;
    bottom: 20px;
    right: 16px;
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }

  .mob-btn {
    background: #b91c1c;
    border: 2px solid #fca5a5;
    color: white;
    font-size: 14px;
    font-weight: 800;
    letter-spacing: 0.08em;
    padding: 10px 18px;
    border-radius: 8px;
    cursor: pointer;
    box-shadow: 0 2px 12px rgba(185,28,28,0.6);
    transition: background 0.15s, transform 0.1s;
    width: 52px;
    height: 52px;
    padding: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mob-btn svg { width: 100%; height: 100%; display: block; }
  @media (hover: hover) and (pointer: fine) {
    .mob-btn:hover { background: #991b1b; transform: scale(1.04); }
  }
  .mob-btn:active { transform: scale(0.97); }
</style>
