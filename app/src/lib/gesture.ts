/**
 * Gesture recognizer contract for the map canvas.
 *
 * HitTarget  — exhaustive taxonomy of everything tappable/draggable on the map.
 *              Adding a new interactive element means adding a variant here; the
 *              compiler then points to every unhandled site in dispatchTap.
 *              hit() returns null for bare map (no target) — the FSM handles that directly.
 *
 * Gesture    — exhaustive set of recognized user intentions.
 *              Adding a new gesture (e.g. double-tap) means adding a variant here;
 *              the compiler then rejects the handleGesture switch until it is handled.
 *
 * DragTarget — subset of HitTarget that can be dragged (ruler/planner handles).
 *              Used to type the 'dragging' FSM phase so drag-move/end always know
 *              the concrete drag subject without an extra runtime null-check.
 */

import type maplibregl from 'maplibre-gl';

// ── Hit taxonomy ─────────────────────────────────────────────────────────────

export type HitTarget =
  | { kind: 'ruler-handle';        rulerId: string; endpoint: 'a' | 'b' }
  | { kind: 'planner-handle';      idx: number }
  | { kind: 'planner-segment';     segIdx: number }
  | { kind: 'ruler-label';         rulerId: string }
  | { kind: 'own-vessel' }
  | { kind: 'ais-vessel';          vesselIdx: number; coordinate: [number, number] }
  | { kind: 'ais-vessels-ambig';   indices: number[];  coordinate: [number, number] }
  | { kind: 'waypoint';            feature: maplibregl.MapGeoJSONFeature }
  | { kind: 'active-route';        wptFeature?: maplibregl.MapGeoJSONFeature }
  | { kind: 'route';               feature: maplibregl.MapGeoJSONFeature }

/** Targets that support drag interaction. */
export type DragTarget = Extract<HitTarget, { kind: 'ruler-handle' | 'planner-handle' }>

// ── Gesture vocabulary ────────────────────────────────────────────────────────

export type Gesture =
  // A short press-and-release on any target.
  | { type: 'tap';          target: HitTarget;  lngLat: maplibregl.LngLat; clientX: number; clientY: number }
  // A touch held past the long-press threshold on empty map space.
  | { type: 'long-press';   lngLat: maplibregl.LngLat }
  // Drag lifecycle: start → one or more moves → end or cancel.
  | { type: 'drag-start';   target: DragTarget }
  | { type: 'drag-move';    target: DragTarget; lngLat: maplibregl.LngLat }
  | { type: 'drag-end';     target: DragTarget; lngLat: maplibregl.LngLat; snapId: string | undefined }
  | { type: 'drag-cancel';  target: DragTarget }
  // Right-click / system context menu.
  | { type: 'context-menu'; lngLat: maplibregl.LngLat; plannerHandleIdx: number | undefined }
