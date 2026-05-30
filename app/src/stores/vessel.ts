import { writable, derived } from 'svelte/store';

export interface VesselPosition {
  longitude: number;
  latitude: number;
}

export interface CoursePoint {
  longitude: number;
  latitude: number;
}

export interface ActiveRoute {
  href: string;
  name?: string;
  pointIndex: number;
  reverse: boolean;
}

export interface CourseState {
  nextPoint?: CoursePoint;
  previousPoint?: CoursePoint;
  activeRoute?: ActiveRoute;
}

export interface VesselState {
  position: VesselPosition | null;
  cog: number | null;     // radians
  sog: number | null;     // m/s
  heading: number | null; // radians
  course?: CourseState;
}

export const vesselState = writable<VesselState>({
  position: null,
  cog: null,
  sog: null,
  heading: null,
});

// Derived store that only notifies when position actually changes (not on 60 Hz heading ticks).
// vesselState.update spreads the old object, so position keeps the same reference when only
// heading/COG/SOG change — derived's === check prevents spurious re-runs of effects that
// only care about position (route rendering, camera follow, etc.).
export const vesselPosition = derived(vesselState, $vs => $vs.position);
