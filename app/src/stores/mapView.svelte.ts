export type ProjectionId = 'globe' | 'mercator';

const VIEW_LS_KEY       = 'map-view-coords';
const PROJECTION_LS_KEY = 'map-view-projection';

export interface SavedMapView { center: [number, number]; zoom: number; bearing: number }

/** Oslo — used only on the very first run, before any view has ever been saved. */
const DEFAULT_VIEW: SavedMapView = { center: [10.75, 59.91], zoom: 10, bearing: 0 };

/** Reads the last-persisted camera view, falling back to Oslo on first run / corrupt data. */
export function loadSavedView(): SavedMapView {
  try {
    const s = localStorage.getItem(VIEW_LS_KEY);
    if (s) {
      const p = JSON.parse(s) as { center?: unknown; zoom?: unknown; bearing?: unknown };
      if (
        Array.isArray(p.center) && p.center.length === 2 &&
        typeof p.center[0] === 'number' && typeof p.center[1] === 'number' &&
        typeof p.zoom === 'number'
      ) {
        return {
          center: [p.center[0], p.center[1]],
          zoom: p.zoom,
          bearing: typeof p.bearing === 'number' ? p.bearing : 0,
        };
      }
    }
  } catch { /* ignore */ }
  return { center: [...DEFAULT_VIEW.center], zoom: DEFAULT_VIEW.zoom, bearing: DEFAULT_VIEW.bearing };
}

/** Call this on map `moveend` — keeps the store in sync and persists to localStorage. */
export function saveView(center: [number, number], zoom: number, bearing: number): void {
  try { localStorage.setItem(VIEW_LS_KEY, JSON.stringify({ center, zoom, bearing })); } catch { /* ignore */ }
}

/** Reads the last-persisted projection, falling back to mercator on first run / corrupt data. */
function loadSavedProjection(): ProjectionId {
  try {
    const s = localStorage.getItem(PROJECTION_LS_KEY);
    if (s === 'globe' || s === 'mercator') return s;
  } catch { /* ignore */ }
  return 'mercator';
}

function createMapViewStore() {
  const saved     = loadSavedView();
  let _center     = $state<[number, number]>(saved.center);
  let _zoom       = $state<number>(saved.zoom);
  let _bearing    = $state<number>(saved.bearing);
  let projection  = $state<ProjectionId>(loadSavedProjection());
  let isFullscreen = $state(false);

  return {
    get projection()    { return projection; },
    set projection(v: ProjectionId) {
      projection = v;
      try { localStorage.setItem(PROJECTION_LS_KEY, v); } catch { /* ignore */ }
    },
    get isFullscreen()  { return isFullscreen; },
    set isFullscreen(v: boolean) { isFullscreen = v; },

    /** Live camera position (updated on every map `moveend`). */
    get center():  [number, number] { return _center;  },
    get zoom():    number           { return _zoom;    },
    get bearing(): number           { return _bearing; },

    /** Called on map `moveend` — updates reactive state and persists to localStorage. */
    syncView(c: [number, number], z: number, b: number): void {
      _center  = c;
      _zoom    = z;
      _bearing = b;
      saveView(c, z, b);
    },
  };
}

export const mapView = createMapViewStore();
