import { writable } from 'svelte/store';

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
