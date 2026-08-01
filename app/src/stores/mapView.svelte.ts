export type ProjectionId = 'globe' | 'mercator';

const VIEW_LS_KEY       = 'map-view-coords';
const PROJECTION_LS_KEY = 'map-view-projection';

export interface SavedMapView { center: [number, number]; zoom: number; bearing: number }

/** Oslo — used only on the very first run, before any view has ever been saved. */
const DEFAULT_VIEW: SavedMapView = { center: [10.75, 59.91], zoom: 10, bearing: 0 };

/** Reads the last-persisted camera view; null on first run / corrupt data. */
function loadSavedView(key: string): SavedMapView | null {
  try {
    const s = localStorage.getItem(key);
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
  return null;
}

/** Per-pane camera state: live center/zoom/bearing plus projection choice. */
export interface MapViewStore {
  projection: ProjectionId;
  /** Live camera position (updated on every map `moveend`). */
  readonly center: [number, number];
  readonly zoom: number;
  readonly bearing: number;
  /** Called on map `moveend` — updates reactive state and persists to localStorage. */
  syncView(c: [number, number], z: number, b: number): void;
  /** Called on map `rotate` — updates reactive bearing without persisting (persist happens on moveend). */
  updateBearing(b: number): void;
  /** True once a camera view was ever persisted for this pane (used to seed pane 1 from pane 0 on first split enable). */
  readonly hasSavedView: boolean;
}

/**
 * `lsSuffix` namespaces the localStorage keys per pane: '' for the primary
 * pane (legacy keys — no migration needed), ':1' for the second pane.
 */
export function createMapViewStore(lsSuffix = ''): MapViewStore {
  const viewKey = VIEW_LS_KEY + lsSuffix;
  const projKey = PROJECTION_LS_KEY + lsSuffix;

  const saved     = loadSavedView(viewKey);
  let hasSaved    = saved !== null;
  const init      = saved ?? { center: [...DEFAULT_VIEW.center] as [number, number], zoom: DEFAULT_VIEW.zoom, bearing: DEFAULT_VIEW.bearing };
  let _center     = $state<[number, number]>(init.center);
  let _zoom       = $state<number>(init.zoom);
  let _bearing    = $state<number>(init.bearing);

  let projection  = $state<ProjectionId>('mercator');
  try {
    const s = localStorage.getItem(projKey);
    if (s === 'globe' || s === 'mercator') projection = s;
  } catch { /* ignore */ }

  return {
    get projection()    { return projection; },
    set projection(v: ProjectionId) {
      projection = v;
      try { localStorage.setItem(projKey, v); } catch { /* ignore */ }
    },

    get center():  [number, number] { return _center;  },
    get zoom():    number           { return _zoom;    },
    get bearing(): number           { return _bearing; },

    syncView(c: [number, number], z: number, b: number): void {
      _center  = c;
      _zoom    = z;
      _bearing = b;
      hasSaved = true;
      try { localStorage.setItem(viewKey, JSON.stringify({ center: c, zoom: z, bearing: b })); } catch { /* ignore */ }
    },
    updateBearing(b: number): void { _bearing = b; },
    get hasSavedView(): boolean { return hasSaved; },
  };
}
