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
}

/**
 * Own-vessel navigation state. Every field is its own signal, so a reader
 * re-runs only when a field it actually read changes — the compass writing
 * heading at display rate never invalidates position-only readers.
 */
export interface VesselStore extends Readonly<VesselState> {
  /** Replaces the whole state with a new fix (Signal K or browser geolocation). */
  set(fix: VesselState): void;
  /** Heading-only update (device compass, up to display rate). */
  setHeading(heading: number | null): void;
  /**
   * Plain, non-live copy of the current state. Reading it inside an effect
   * still subscribes to every field — wrap in untrack() when the effect must
   * not depend on vessel state.
   */
  snapshot(): VesselState;
}

function createVessel(): VesselStore {
  // Replaced wholesale on every fix, never mutated in place → raw, no deep proxy.
  let position = $state.raw<VesselPosition | null>(null);
  let cog      = $state<number | null>(null);
  let sog      = $state<number | null>(null);
  let heading  = $state<number | null>(null);

  return {
    get position() { return position; },
    get cog()      { return cog; },
    get sog()      { return sog; },
    get heading()  { return heading; },

    set(fix) {
      position = fix.position;
      cog      = fix.cog;
      sog      = fix.sog;
      heading  = fix.heading;
    },

    setHeading(h) { heading = h; },

    snapshot() {
      return { position, cog, sog, heading };
    },
  };
}

export const vessel = createVessel();
