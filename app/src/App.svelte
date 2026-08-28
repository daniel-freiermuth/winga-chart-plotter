<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Map from './components/Map.svelte';
  import FaIcon from './lib/FaIcon.svelte';
  import {
    faGear, faRuler,
  } from '@fortawesome/free-solid-svg-icons';
  import { routePlanner } from './stores/routePlanner.svelte';
  import { waypoints } from './stores/waypoints.svelte';
  import { saveRoute, updateRoute, raiseMob, activateRoute, setActiveRoutePointIndex } from './lib/wasmRest';
  import { gcDistanceNm, unionViewBounds } from './lib/wasmGeo';

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
    if (!routePlanner.name.trim() || routePlanner.waypoints.length < 2) return;
    plannerSaving = true;
    plannerError = null;
    // Capture before any async call — state is cleared by routePlanner.exit().
    const editingUuid           = routePlanner.editingRouteUuid;
    const wasEditingActiveRoute = editingUuid !== null && editingUuid === route.activeUuid;
    const anchorPoint           = wasEditingActiveRoute ? routePlanner.anchorPoint : null;
    try {
      if (editingUuid) {
        await updateRoute(settings.signalkHttpUrl, editingUuid, routePlanner.name.trim(), routePlanner.waypoints, auth.authHeaders);
      } else {
        await saveRoute(settings.signalkHttpUrl, routePlanner.name.trim(), routePlanner.waypoints, auth.authHeaders);
      }
      // Capture new waypoints before exit() wipes them.
      const newWaypoints = [...routePlanner.waypoints];
      routePlanner.exit();
      await routes.load(settings.signalkHttpUrl);
      // Re-anchor navigation to the closest waypoint in the updated route.
      if (wasEditingActiveRoute && editingUuid) {
        await activateRoute(settings.signalkHttpUrl, editingUuid, auth.authHeaders);
        if (anchorPoint && newWaypoints.length > 0) {
          let closestIdx  = 0;
          let closestDist = Infinity;
          for (let i = 0; i < newWaypoints.length; i++) {
            const wpt = newWaypoints[i]!;
            const d   = gcDistanceNm(anchorPoint.lon, anchorPoint.lat, wpt.lon, wpt.lat);
            if (d < closestDist) { closestDist = d; closestIdx = i; }
          }
          if (closestIdx > 0) {
            await setActiveRoutePointIndex(settings.signalkHttpUrl, closestIdx, auth.authHeaders);
          }
        }
      }
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
  import WidgetPlaceholder from './components/WidgetPlaceholder.svelte';
  import ExtPanel from './components/ExtPanel.svelte';
  import { vesselState } from './stores/vessel';
  import { settings, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX, type SettingsTab } from './stores/settings.svelte';
  import { panes, setPaneLayout, visiblePanesFor, type PaneState } from './stores/pane.svelte';
  import { startRulerSnapSync } from './lib/rulerSnap';
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
    addRuler(): void;
    setProjection(proj: string): void;
    closePopup(): void;
  }

  let mapComp             = $state<MapInstance | null>(null);
  let mapComp1            = $state<MapInstance | null>(null);
  /** Pane the (single, app-level) chart picker is open for; null = closed. */
  // $state.raw: PaneState must keep its identity (compared against panes[i]);
  // a deep $state proxy would break === and re-proxy the pane's stores.
  let pickerFor           = $state.raw<PaneState | null>(null);
  let settingsComp        = $state<{ open(): void; openTo(t: SettingsTab): void } | null>(null);

  // ── Split divider drag ────────────────────────────────────────────────────
  // The divider doubles as the split-view control: outside the split it parks
  // at the collapsed pane's screen edge as a drawer handle — EITHER edge is a
  // resting position (paneLayout names the pane that stays fullscreen).
  // Grabbing the handle mounts the other pane and the divider follows the
  // pointer; the release either settles into the 20-80% band or collapses a
  // pane again. No Settings toggle needed.
  let panesEl: HTMLDivElement | undefined;
  /** Live ratio during a divider drag; null when idle or parked (persisted value applies). */
  let dragRatio = $state<number | null>(null);
  /** True from pointerdown to up/cancel — disables the settle transition so the divider tracks the pointer exactly. */
  let dividerDragging = $state(false);
  const splitRatio = $derived(dragRatio ?? settings.splitRatio);
  const splitOpen  = $derived(settings.paneLayout === 'split');
  const pane0Visible = $derived(visiblePanesFor(settings.paneLayout).includes(panes[0]));
  const pane1Visible = $derived(visiblePanesFor(settings.paneLayout).includes(panes[1]));
  /** Release threshold: let go with a pane under half its minimum size and that pane collapses. */
  const SPLIT_OPEN_THRESHOLD = SPLIT_RATIO_MIN / 2;
  // Divider orientation for screen readers — mirrors the CSS orientation media
  // query that lays out the panes: side-by-side panes (landscape) are split by
  // a vertical separator, stacked panes (portrait) by a horizontal one.
  const landscapeMql = window.matchMedia('(orientation: landscape)');
  let isLandscape = $state(landscapeMql.matches);

  /** Raw divider position as a pane-0 fraction — unclamped, so the parked zone is reachable. */
  function dividerFracFromEvent(e: PointerEvent): number {
    if (!panesEl) return settings.splitRatio;
    const r = panesEl.getBoundingClientRect();
    // Horizontal split axis in landscape, vertical in portrait — same
    // orientation source the pane layout CSS and aria-orientation use (the
    // aspect-ratio test would disagree with the media query at width == height).
    return isLandscape
      ? (e.clientX - r.left) / r.width
      : (e.clientY - r.top) / r.height;
  }
  function onDividerDown(e: PointerEvent): void {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dividerDragging = true;
    // Opening gesture: mount the collapsed pane immediately so it follows the
    // pointer out of the edge from the first moment — that is what makes
    // the drawer discoverable.
    if (!splitOpen) setPaneLayout('split');
    onDividerMove(e);
  }
  function onDividerMove(e: PointerEvent): void {
    if (!dividerDragging) return;
    // Follow the pointer everywhere, including outside the 20-80% band —
    // the release below either bounces back into the band or collapses a pane.
    dragRatio = Math.min(1, Math.max(0, dividerFracFromEvent(e)));
  }
  function onDividerUp(): void {
    if (!dividerDragging) return;
    dividerDragging = false;
    if (dragRatio !== null) {
      // Released (almost) at an edge — that pane collapses and the divider
      // parks. The pre-drag ratio is deliberately not overwritten, so the
      // next open restores it.
      if (1 - dragRatio < SPLIT_OPEN_THRESHOLD)  setPaneLayout('solo0');
      else if (dragRatio < SPLIT_OPEN_THRESHOLD) setPaneLayout('solo1');
      else settings.setSplitRatio(dragRatio); // clamps → settles back into the band
    }
    dragRatio = null;
  }
  function onDividerKey(e: KeyboardEvent): void {
    const delta = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -0.05
                : (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 0.05 : 0;
    if (delta === 0) return;
    e.preventDefault();
    if (!splitOpen) {
      // Parked: a step inward (away from the parked edge) re-opens the split
      // at its last persisted ratio.
      if (settings.paneLayout === 'solo0' ? delta < 0 : delta > 0) setPaneLayout('split');
      return;
    }
    // Already at a clamp — one more step outward collapses that side's pane.
    if (delta > 0 && settings.splitRatio >= SPLIT_RATIO_MAX) { setPaneLayout('solo0'); return; }
    if (delta < 0 && settings.splitRatio <= SPLIT_RATIO_MIN) { setPaneLayout('solo1'); return; }
    settings.setSplitRatio(settings.splitRatio + delta); // store clamps
  }
  let worker: Worker | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 2000; // ms, doubles on each failure up to 30s

  // Plotter-extensions relay and control objects
  const relay = createSkRelay((msg) => worker?.postMessage({ type: 'send', msg }));

  const mapControl: MapControl = {
    // Visible area across panes: in split view, the dateline-aware union of
    // both cameras (WASM — arcs on the circle, so two panes on either side of
    // the antimeridian merge across it instead of spanning the globe through
    // Greenwich). zoom is min(z0, z1): a scale bound ("no more zoomed-in than
    // the most zoomed-out pane"), NOT a fit — a fit zoom would need a target
    // viewport, and a cross-pane union has none.
    getView: () => {
      // Either pane can be the solo/fullscreen one — gather whatever is mounted.
      const v0 = pane0Visible ? mapComp?.getView() : null;
      const v1 = pane1Visible ? mapComp1?.getView() : null;
      // Extension asks before any pane's Map has mounted — degrade to the
      // same empty view Map.getView() itself returns when it has no map.
      if (!v0 && !v1) return { center: [0, 0] as [number, number], zoom: 0, bounds: [0, 0, 0, 0] as [number, number, number, number] };
      if (!v0 || !v1) return (v0 ?? v1)!;
      const u = unionViewBounds(v0.bounds, v1.bounds);
      return {
        center: u.center,
        zoom: Math.min(v0.zoom, v1.zoom),
        bounds: u.bounds,
      };
    },
    // Extensions may not steer the camera — navigation intent comes from the
    // user. Kept as warning no-ops so existing extensions keep working.
    flyTo:     () => { console.warn('[ext] map.flyTo ignored — extensions cannot move the map'); },
    fitBounds: () => { console.warn('[ext] map.fitBounds ignored — extensions cannot move the map'); },
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
          // Same reasoning for the extension list, which decides whether widgets
          // render at all: a stream that just came up is the best evidence we get
          // that a server which was down or restarting is serving again.
          void plotterExtensions.load(settings.signalkHttpUrl);
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
        // A connect that throws in the worker never produces a status event, so
        // without this the retry chain stops dead and the app stays offline
        // until the user reloads the page.
        connection.setConnected(false);
        scheduleReconnect();
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

    const onOrientationChange = () => { isLandscape = landscapeMql.matches; };
    landscapeMql.addEventListener('change', onOrientationChange);

    // App-level frame driver: keeps snapped ruler endpoints following live
    // vessel positions — shared world data, synced once regardless of panes.
    const stopRulerSnap = startRulerSnapSync();

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      landscapeMql.removeEventListener('change', onOrientationChange);
      stopRulerSnap();
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
    pickerFor = null;
    settingsComp?.openTo(tab);
  }
  function handleOpenSettingsModal(): void {
    mapComp?.closePopup();
    mapComp1?.closePopup();
    pickerFor = null;
    settingsComp?.open();
  }
  function openChartPickerFor(p: PaneState): void {
    pickerFor = p;
    mapComp?.closePopup();
    mapComp1?.closePopup();
  }
  // Collapsing a pane closes its picker — a deliberate gesture should not
  // covertly retarget the sheet at the surviving pane.
  $effect(() => {
    if (pickerFor === panes[0] && !pane0Visible) pickerFor = null;
    else if (pickerFor === panes[1] && !pane1Visible) pickerFor = null;
  });
  // Rulers are shared world data rendered in BOTH panes — only the initial
  // placement is viewport-relative. It spawns in the BIGGER pane: that is
  // where the user has room to work; outside the split that is the solo pane.
  // (pickerFor tracks the chart picker, not "the last active map", so
  // routing through it would be no less arbitrary.)
  function handleAddRuler(): void {
    pickerFor = null;
    const useSecond = splitOpen ? settings.splitRatio < 0.5 : settings.paneLayout === 'solo1';
    (useSecond ? mapComp1 : mapComp)?.addRuler();
  }
  function handleToggleProjection(): void {
    const p = pickerFor;
    if (!p) return; // only reachable from inside the open sheet
    const target = p === panes[1] ? mapComp1 : mapComp;
    target?.setProjection(p.view.projection === 'mercator' ? 'globe' : 'mercator');
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
  <div class="panes" class:panes--dragging={dividerDragging} bind:this={panesEl} style="--split: {(splitRatio * 100).toFixed(2)}%">
    {#if pane0Visible}
      <div id="pane-primary" class="pane" class:pane--sized={splitOpen}>
        <Map
          bind:this={mapComp}
          pane={panes[0]}
          openSettings={handleOpenSettings}
          onMapClick={() => { pickerFor = null; }}
          chartPickerOpen={pickerFor === panes[0]}
          onOpenChartPicker={() => { openChartPickerFor(panes[0]); }}
        />
      </div>
    {/if}
    <!-- WAI-ARIA "window splitter" pattern: a focusable separator with
         aria-valuenow IS the interactive variant per the ARIA spec; the
         checker doesn't model it. The divider always exists — parked at a
         screen edge it is the handle that OPENS the split (valuenow 100 =
         second pane fully collapsed, 0 = primary pane fully collapsed, per
         the collapsible-splitter pattern). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="split-divider"
      class:split-divider--parked-end={settings.paneLayout === 'solo0'}
      class:split-divider--parked-start={settings.paneLayout === 'solo1'}
      role="separator"
      tabindex="0"
      aria-label={splitOpen ? 'Resize panes' : 'Open split view'}
      aria-controls={pane0Visible ? 'pane-primary' : 'pane-second'}
      aria-orientation={isLandscape ? 'vertical' : 'horizontal'}
      aria-valuenow={splitOpen ? Math.round(splitRatio * 100) : settings.paneLayout === 'solo0' ? 100 : 0}
      aria-valuemin={0}
      aria-valuemax={100}
      onpointerdown={onDividerDown}
      onpointermove={onDividerMove}
      onpointerup={onDividerUp}
      onpointercancel={onDividerUp}
      onlostpointercapture={onDividerUp}
      onkeydown={onDividerKey}
    ></div>
    {#if pane1Visible}
      <div id="pane-second" class="pane pane--second">
        <Map
          bind:this={mapComp1}
          pane={panes[1]}
          fpsOwner={!pane0Visible}
          openSettings={handleOpenSettings}
          onMapClick={() => { pickerFor = null; }}
          chartPickerOpen={pickerFor === panes[1]}
          onOpenChartPicker={() => { openChartPickerFor(panes[1]); }}
        />
      </div>
    {/if}
  </div>
  <Settings bind:this={settingsComp} />
  {#if pickerFor}
    <ChartPicker pane={pickerFor} onClose={() => { pickerFor = null; }} onToggleProjection={handleToggleProjection} />
  {/if}
  {#each plotterExtensions.layout as placement (placement.instanceId)}
    {@const manifest = plotterExtensions.extensions.get(placement.extensionId)}
    {@const wDef = manifest?.widgets?.find(w => w.id === placement.widgetId)}
    {#if manifest && wDef}
      <WidgetPanel {placement} widgetDef={wDef} {mapControl} {panelControl} {relay} />
    {:else}
      <WidgetPlaceholder {placement} />
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
            onkeydown={(e) => { if (e.key === 'Enter' && !e.isComposing && !plannerSaving && routePlanner.name.trim() && routePlanner.waypoints.length >= 2) void handleSaveRoute(); }}
            style="
              flex: 1; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.25);
              border-radius: 6px; color: white; padding: 5px 8px; font-size: 13px; outline: none;
            "
          />
          <button
            title={routePlanner.editingRouteUuid ? 'Update route' : 'Save as route'}
            disabled={plannerSaving || !routePlanner.name.trim() || routePlanner.waypoints.length < 2}
            onclick={handleSaveRoute}
            style="
              background: rgba(100,200,100,0.8); border: none; outline: none; color: white;
              padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 13px;
              opacity: {plannerSaving || !routePlanner.name.trim() || routePlanner.waypoints.length < 2 ? 0.4 : 1};
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

  /* Dual-pane container. Split along the longer viewport edge: side-by-side
     in landscape, stacked in portrait. Single pane = one flex child. */
  .panes {
    position: absolute;
    inset: 0;
    display: flex;
  }
  .pane {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
  }
  /* When split, pane 0 takes the persisted share of the split axis
     (minus half the 2px divider); pane 1 fills the rest. The transition is
     the release "bounce": a drag can leave the divider outside the 20-80%
     band, and letting go animates it back to the clamped ratio (or the
     edge, when closing). During a drag it is off so the divider tracks the
     pointer exactly. */
  .pane--sized {
    flex: 0 0 calc(var(--split, 50%) - 1px);
    transition: flex-basis 200ms ease;
  }
  .panes--dragging .pane--sized { transition: none; }

  /* The divider element is the visible 2px line itself — same footprint as
     the old pane border. Grabbability comes from the pseudo-elements. The
     line is a gradient with a transparent window under the grab handle
     (48px pill + border), so it doesn't show through the translucent pill. */
  .split-divider {
    flex: 0 0 2px;
    position: relative;
    z-index: 5; /* wins over bare pane content (map canvas) but stays below chrome UI (toolbar, nav-stack, popups all z-index >= 10) so it never swallows their clicks */
    touch-action: none;
    outline-offset: 2px;
  }
  /* Invisible 44px grab zone — pseudo-elements participate in hit testing,
     so the touch target extends over the charts without any visible gutter. */
  .split-divider::before {
    content: '';
    position: absolute;
  }
  /* Grab handle: dark pill with three dots, FAB-styled so it reads on both
     light and dark charts. */
  .split-divider::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    border-radius: 9px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    background-color: rgba(0, 0, 0, 0.6);
    background-image: radial-gradient(circle, rgba(255, 255, 255, 0.85) 2px, transparent 2.6px);
    background-position: center;
  }
  @media (orientation: landscape) {
    .panes { flex-direction: row; }
    .split-divider {
      cursor: col-resize;
      background: linear-gradient(to bottom, #000 calc(50% - 26px), transparent calc(50% - 26px) calc(50% + 26px), #000 calc(50% + 26px));
    }
    .split-divider::before { inset: 0 -21px; }
    /* Parked at an edge: no line to draw, and the grab zone extends inward
       only (the outward half would be offscreen). --parked-end = right edge
       (pane 1 collapsed), --parked-start = left edge (pane 0 collapsed). */
    .split-divider--parked-end, .split-divider--parked-start { background: none; }
    .split-divider--parked-end::before   { inset: 0 0 0 -42px; }
    .split-divider--parked-start::before { inset: 0 -42px 0 0; }
    /* 48px tall, 16px tile → exactly three dots stacked vertically. */
    .split-divider::after { width: 18px; height: 48px; background-size: 18px 16px; background-repeat: repeat-y; }
  }
  @media (orientation: portrait) {
    .panes { flex-direction: column; }
    .split-divider {
      cursor: row-resize;
      background: linear-gradient(to right, #000 calc(50% - 26px), transparent calc(50% - 26px) calc(50% + 26px), #000 calc(50% + 26px));
    }
    .split-divider::before { inset: -21px 0; }
    /* Parked at the bottom (--parked-end, pane 1 collapsed) or top
       (--parked-start, pane 0 collapsed) edge: grab zone extends inward only. */
    .split-divider--parked-end, .split-divider--parked-start { background: none; }
    .split-divider--parked-end::before   { inset: -42px 0 0 0; }
    .split-divider--parked-start::before { inset: 0 0 -42px 0; }
    /* 48px wide, 16px tile → exactly three dots in a row. */
    .split-divider::after { width: 48px; height: 18px; background-size: 16px 18px; background-repeat: repeat-x; }
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
