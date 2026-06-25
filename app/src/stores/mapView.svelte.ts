export type ProjectionId = 'globe' | 'mercator';

const VIEW_LS_KEY = 'map-view-coords';

export interface SavedMapView { center: [number, number]; zoom: number }

/** Oslo — used only on the very first run, before any view has ever been saved. */
const DEFAULT_VIEW: SavedMapView = { center: [10.75, 59.91], zoom: 10 };

/** Reads the last-persisted camera view, falling back to Oslo on first run / corrupt data. */
export function loadSavedView(): SavedMapView {
  try {
    const s = localStorage.getItem(VIEW_LS_KEY);
    if (s) {
      const p = JSON.parse(s) as { center?: unknown; zoom?: unknown };
      if (
        Array.isArray(p.center) && p.center.length === 2 &&
        typeof p.center[0] === 'number' && typeof p.center[1] === 'number' &&
        typeof p.zoom === 'number'
      ) {
        return { center: [p.center[0], p.center[1]], zoom: p.zoom };
      }
    }
  } catch { /* ignore */ }
  return { center: [...DEFAULT_VIEW.center], zoom: DEFAULT_VIEW.zoom };
}

/** Persists the current camera view. Called on 'moveend' — cheap, low-frequency. */
export function saveView(center: [number, number], zoom: number): void {
  try { localStorage.setItem(VIEW_LS_KEY, JSON.stringify({ center, zoom })); } catch { /* ignore */ }
}

function createMapViewStore() {
  let projection  = $state<ProjectionId>('mercator');
  let isFullscreen = $state(false);

  return {
    get projection()   { return projection; },
    set projection(v: ProjectionId) { projection = v; },
    get isFullscreen() { return isFullscreen; },
    set isFullscreen(v: boolean)    { isFullscreen = v; },
  };
}

export const mapView = createMapViewStore();
