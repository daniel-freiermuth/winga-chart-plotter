import { createMapViewStore, type MapViewStore } from './mapView.svelte';
import { createFollowStore, type FollowStore } from './follow.svelte';
import { createRotateModeStore, type RotateModeStore } from './rotateMode.svelte';
import { createVisibilityStore, type VisibilityStore } from './visibility.svelte';
import { createBaseLayersStore, type BaseLayersStore } from './baseLayers.svelte';
import { createChartSelStore, type ChartSelStore } from './chartSel.svelte';
import { settings } from './settings.svelte';

/**
 * Pane state — everything that is *a way of looking at the world*, replicated
 * per pane in split view: camera, projection, chart/base-layer selection,
 * layer visibility, rotation mode, vessel follow.
 *
 * App-level stores (Signal K connection, AIS, vessel, routes, waypoints,
 * tracks, rulers, settings, …) are *data about the world* and stay singletons;
 * both panes render them.
 */
export interface PaneState {
  readonly id: number;
  /**
   * Pane 0 — always present (split view only ever adds/removes pane 1) and
   * owner of the legacy un-suffixed localStorage keys. Sole remaining
   * per-frame duty: FPS measurement (the metric tracks a map render loop, and
   * the primary pane's is representative).
   */
  readonly isPrimary: boolean;
  readonly view:       MapViewStore;
  readonly follow:     FollowStore;
  readonly rotate:     RotateModeStore;
  readonly visibility: VisibilityStore;
  readonly baseLayers: BaseLayersStore;
  readonly chartSel:   ChartSelStore;
}

export function createPaneState(id: number): PaneState {
  const lsSuffix = id === 0 ? '' : `:${String(id)}`;
  return {
    id,
    isPrimary: id === 0,
    view:       createMapViewStore(lsSuffix),
    follow:     createFollowStore(lsSuffix),
    rotate:     createRotateModeStore(lsSuffix),
    visibility: createVisibilityStore(lsSuffix),
    baseLayers: createBaseLayersStore(lsSuffix),
    chartSel:   createChartSelStore(lsSuffix),
  };
}

/**
 * Both panes exist eagerly (cheap: a handful of runes + localStorage reads);
 * pane 1 is only *rendered* while split view is enabled, so no reactive pane
 * list is needed.
 */
export const panes: readonly [PaneState, PaneState] = [createPaneState(0), createPaneState(1)];

export const primaryPane: PaneState = panes[0];

/**
 * First split enable: pane 1 has no persisted camera yet — clone pane 0's live
 * camera and projection so the split starts as "same view, then diverge".
 * syncView() persists, so this runs at most once per fresh pane 1.
 */
function ensureSecondPaneSeeded(): void {
  const [p0, p1] = panes;
  if (p1.view.hasSavedView) return;
  p1.view.projection = p0.view.projection;
  p1.view.syncView([p0.view.center[0], p0.view.center[1]], p0.view.zoom, p0.view.bearing);
}

/** Toggle split view. Seeds pane 1 synchronously BEFORE it mounts. */
export function setSplitViewEnabled(on: boolean): void {
  if (on) ensureSecondPaneSeeded();
  settings.setSplitView(on);
}

// Booting with split already enabled but pane 1 never persisted (keys cleared
// out-of-band): seed at module init, before any component renders.
if (settings.splitView) ensureSecondPaneSeeded();
