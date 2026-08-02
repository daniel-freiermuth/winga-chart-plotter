import { createMapViewStore, type MapViewStore } from './mapView.svelte';
import { createFollowStore, type FollowStore } from './follow.svelte';
import { createRotateModeStore, type RotateModeStore } from './rotateMode.svelte';
import { createVisibilityStore, type VisibilityStore } from './visibility.svelte';
import { createBaseLayersStore, type BaseLayersStore } from './baseLayers.svelte';
import { createChartSelStore, type ChartSelStore } from './chartSel.svelte';
import { settings, type PaneLayout } from './settings.svelte';

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

/** Clone `from`'s live camera and projection into `to`. syncView() persists. */
function seedPane(from: PaneState, to: PaneState): void {
  to.view.projection = from.view.projection;
  to.view.syncView([from.view.center[0], from.view.center[1]], from.view.zoom, from.view.bearing, from.view.pitch);
}

/**
 * A pane about to mount without a persisted camera clones the other pane, so
 * every layout change starts as "same view, then diverge". Symmetric: pane 1
 * is the fresh one on the first split enable; pane 0 can be the fresh one too
 * (e.g. reopening the split after booting straight into 'solo1' with the
 * legacy un-suffixed keys cleared out-of-band). A pane with nothing persisted
 * itself is never a clone source — both panes are at the built-in default
 * then, and seeding runs at most once per fresh pane because syncView()
 * persists.
 */
function ensureMountedPanesSeeded(layout: PaneLayout): void {
  const [p0, p1] = panes;
  if (layout !== 'solo0' && !p1.view.hasSavedView && p0.view.hasSavedView) seedPane(p0, p1);
  if (layout !== 'solo1' && !p0.view.hasSavedView && p1.view.hasSavedView) seedPane(p1, p0);
}

/** Switch the pane layout. Panes the layout mounts are seeded synchronously BEFORE they mount. */
export function setPaneLayout(layout: PaneLayout): void {
  ensureMountedPanesSeeded(layout);
  settings.setPaneLayout(layout);
}

// Booting with a mounted pane that never persisted a camera (keys cleared
// out-of-band): seed at module init, before any component renders.
ensureMountedPanesSeeded(settings.paneLayout);
