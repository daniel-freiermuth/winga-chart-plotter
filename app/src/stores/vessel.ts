import { writable } from 'svelte/store';

export interface VesselPosition {
  longitude: number;
  latitude: number;
}

export interface VesselState {
  position: VesselPosition | null;
  cog: number | null;     // radians
  sog: number | null;     // m/s
  heading: number | null; // radians
}

export const vesselState = writable<VesselState>({
  position: null,
  cog: null,
  sog: null,
  heading: null,
});
