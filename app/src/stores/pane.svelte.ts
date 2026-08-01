import { createMapViewStore, type MapViewStore } from './mapView.svelte';
import { createFollowStore, type FollowStore } from './follow.svelte';
import { createRotateModeStore, type RotateModeStore } from './rotateMode.svelte';
import { createVisibilityStore, type VisibilityStore } from './visibility.svelte';
import { createBaseLayersStore, type BaseLayersStore } from './baseLayers.svelte';
import { createChartSelStore, type ChartSelStore } from './chartSel.svelte';

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

/** Pane 0 always exists; enabling split view (later) appends pane 1. */
export const panes: PaneState[] = [createPaneState(0)];

export const primaryPane: PaneState = panes[0] as PaneState;
