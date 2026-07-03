/**
 * Gesture recognizer contract for the map canvas.
 *
 * HitTarget    — self-describing interface; each interactive element carries its own
 *               behavior. No central dispatch switch — the FSM calls target methods directly.
 *
 * Interactable — one interactive layer; owns its pick logic and returns the HitTarget
 *               (with behavior) or null. Add one entry to INTERACTIONS per new element.
 *
 * DragTarget   — HitTarget guaranteed to support dragging (drag property is required).
 *
 * Gesture      — recognized user intentions emitted by the FSM to handleGesture.
 *               Adding a new gesture type requires one more case in handleGesture.
 */

import type maplibregl from 'maplibre-gl';

// -- Drag behavior ----------------------------------------------------------------

export interface DragBehavior {
  /** Snap the released endpoint to a nearby AIS/vessel target at drag-end. */
  readonly snapsToTargets: boolean;
  onMove(lngLat: maplibregl.LngLat): void;
  onEnd(lngLat: maplibregl.LngLat, snapId: string | undefined): void;
  onCancel(): void;
}

// -- Hit target -------------------------------------------------------------------

/** An interactive element on the map canvas. Carries its own response to each gesture.
 *  The FSM calls methods directly — no central switch, no kind-based dispatch. */
export interface HitTarget {
  /** Discriminant kept for debugging / logging only. Never used for dispatch. */
  readonly kind: string;
  /** If present, pointer-down immediately initiates a drag operation. */
  readonly drag?: DragBehavior;
  /** Short tap: press + release without significant movement. */
  onTap(lngLat: maplibregl.LngLat, clientX: number, clientY: number): void;
  /** Right-click or OS context-menu event. */
  onContextMenu(lngLat: maplibregl.LngLat): void;
}

/** HitTarget that is guaranteed to be draggable. */
export type DragTarget = HitTarget & { drag: DragBehavior };

// -- Interactable (registry entry) ------------------------------------------------

/** An interactive layer that knows how to hit-test itself and produce a HitTarget.
 *  One instance per interactive element; added to INTERACTIONS in priority order. */
export interface Interactable {
  /** Returns the HitTarget at canvas position (x, y), or null if nothing is hit. */
  pick(x: number, y: number): HitTarget | null;
}

// -- Gesture types ----------------------------------------------------------------

export type Gesture =
  /** Short tap on a concrete interactive element. */
  | { type: 'tap';          target: HitTarget; lngLat: maplibregl.LngLat; clientX: number; clientY: number }
  /** Touch held past the long-press threshold on empty map space. */
  | { type: 'long-press';   lngLat: maplibregl.LngLat }
  /** Drag lifecycle — target is always a DragTarget. */
  | { type: 'drag-start';   target: DragTarget }
  | { type: 'drag-move';    target: DragTarget; lngLat: maplibregl.LngLat }
  | { type: 'drag-end';     target: DragTarget; lngLat: maplibregl.LngLat; snapId: string | undefined }
  | { type: 'drag-cancel';  target: DragTarget }
  /** Right-click / context-menu. target is null for bare map. */
  | { type: 'context-menu'; target: HitTarget | null; lngLat: maplibregl.LngLat };
