import type { VesselInfo } from '../lib/signalk-api';

// ---------------------------------------------------------------------------
// Hot data typed array — stride and field offsets
// ---------------------------------------------------------------------------

/** Number of f64 values per vessel in the hot typed array. */
export const AIS_HOT_STRIDE = 7;
/** Field offsets within each vessel's stride entry. */
export const AIS_F_LON = 0; // longitude
export const AIS_F_LAT = 1; // latitude
export const AIS_F_COG = 2; // course over ground, rad (NaN = unknown)
export const AIS_F_SOG = 3; // speed over ground, m/s (NaN = unknown)
export const AIS_F_HDG = 4; // true heading, rad (NaN = unknown)
export const AIS_F_ROT = 5; // rate of turn, rad/s (NaN = unknown)
export const AIS_F_AGE = 6; // seconds elapsed since last position update at upload time

// ---------------------------------------------------------------------------
// Cold data — strings and REST-enriched vessel metadata
// ---------------------------------------------------------------------------

/** Persistent cold metadata for an AIS vessel, keyed by vessel id in `coldMap`. */
export interface AisColdData {
  id: string;
  // From AIS stream (SignalK):
  name?: string | undefined;
  mmsi?: string | undefined;
  // From REST API (fetchVesselInfo):
  shipType?: string | undefined;
  navState?: string | undefined;
  callsign?: string | undefined;
  callsignHf?: string | undefined;
  skipperName?: string | undefined;
  port?: string | undefined;
  flag?: string | undefined;
  lengthM?: number | undefined;
  beamM?: number | undefined;
  draftM?: number | undefined;
  airHeightM?: number | undefined;
}

// ---------------------------------------------------------------------------
// On-demand target reconstruction (used only for picking / popup display)
// ---------------------------------------------------------------------------

/** Full AIS target, reconstructed on demand from typed array + coldMap.
 *  Not stored permanently — created only when the user clicks a vessel. */
export interface AisTarget {
  id: string;
  mmsi?: string | undefined;
  name?: string | undefined;
  position: { longitude: number; latitude: number };
  cog?: number | undefined;
  sog?: number | undefined;
  heading?: number | undefined;
  rot?: number | undefined;
  /** Approximate epoch ms of the last position update (reconstructed from ageAtUpload). */
  lastPositionUpdateMs: number;
  shipType?: string | undefined;
  navState?: string | undefined;
  callsign?: string | undefined;
  callsignHf?: string | undefined;
  skipperName?: string | undefined;
  port?: string | undefined;
  flag?: string | undefined;
  lengthM?: number | undefined;
  beamM?: number | undefined;
  draftM?: number | undefined;
  airHeightM?: number | undefined;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createAisStore() {
  /** The transferred Float64Array from WASM — one row (STRIDE values) per vessel. */
  let hotData = $state<Float64Array | null>(null);
  /** Vessel IDs in the same order as rows in hotData. */
  let ids = $state<string[]>([]);
  /** Persistent cold metadata map — patched on each batch, never fully replaced. */
  let coldMap = new Map<string, AisColdData>();
  /**
   * Bumped whenever coldMap changes independently of hotData (i.e. setInfoCache).
   * Effects that read coldMap should also read coldVersion to register the dependency.
   */
  let coldVersion = $state(0);

  return {
    get hotData(): Float64Array | null { return hotData; },
    get ids(): string[] { return ids; },
    get coldMap(): Map<string, AisColdData> { return coldMap; },
    get coldVersion(): number { return coldVersion; },
    get count(): number { return ids.length; },

    /**
     * Receive a new AIS batch from the worker.
     * The `hot` ArrayBuffer has been transferred (zero-copy); wrap it in a Float64Array.
     * Patch coldMap with fresh name/mmsi from the AIS stream without discarding REST data.
     */
    updateBinary(
      hot: ArrayBuffer,
      newIds: string[],
      cold: Array<{ id: string; name?: string; mmsi?: string }>,
    ) {
      hotData = new Float64Array(hot);
      ids = newIds;
      for (const c of cold) {
        const existing = coldMap.get(c.id);
        coldMap.set(c.id, {
          ...existing,
          id: c.id,
          name: c.name ?? existing?.name,
          mmsi: c.mmsi ?? existing?.mmsi,
        });
      }
    },

    /**
     * Patch coldMap with REST API vessel info (shipType, dimensions).
     * Bumps coldVersion so effects re-run even if hotData hasn't changed.
     */
    setInfoCache(map: Map<string, VesselInfo>) {
      for (const [id, info] of map) {
        const existing = coldMap.get(id) ?? { id };
        coldMap.set(id, {
          ...existing,
          name:       info.name       ?? existing.name,
          callsign:    info.callsign    ?? existing.callsign,
          callsignHf:  info.callsignHf  ?? existing.callsignHf,
          skipperName: info.skipperName ?? existing.skipperName,
          port:       info.port       ?? existing.port,
          flag:       info.flag       ?? existing.flag,
          shipType:    info.shipType    ?? existing.shipType,
          navState:    info.navState    ?? existing.navState,
          lengthM:    info.lengthM    ?? existing.lengthM,
          beamM:      info.beamM      ?? existing.beamM,
          draftM:     info.draftM     ?? existing.draftM,
          airHeightM: info.airHeightM ?? existing.airHeightM,
        });
      }
      coldVersion++;
    },

    /**
     * Reconstruct a full AisTarget for vessel at `index`.
     * Allocates one object — intended for infrequent use (click handling only).
     * Returns null if index is out of range or hotData is not available.
     */
    getTarget(index: number): AisTarget | null {
      if (!hotData || index < 0 || index >= ids.length) return null;
      const b = index * AIS_HOT_STRIDE;
      // Bounds are guaranteed: ids.length === hotData.length / AIS_HOT_STRIDE.
      const id  = ids[index]!;
      const cold = coldMap.get(id);
      const lon = hotData[b + AIS_F_LON]!;
      const lat = hotData[b + AIS_F_LAT]!;
      const cog = hotData[b + AIS_F_COG]!;
      const sog = hotData[b + AIS_F_SOG]!;
      const hdg = hotData[b + AIS_F_HDG]!;
      const rot = hotData[b + AIS_F_ROT]!;
      const age = hotData[b + AIS_F_AGE]!;
      return {
        id,
        mmsi:    cold?.mmsi,
        name:    cold?.name,
        position: { longitude: lon, latitude: lat },
        cog:     isNaN(cog) ? undefined : cog,
        sog:     isNaN(sog) ? undefined : sog,
        heading: isNaN(hdg) ? undefined : hdg,
        rot:     isNaN(rot) ? undefined : rot,
        lastPositionUpdateMs: Date.now() - age * 1000,
        shipType:    cold?.shipType,
        navState:    cold?.navState,
        callsign:    cold?.callsign,
        callsignHf:  cold?.callsignHf,
        skipperName: cold?.skipperName,
        port:       cold?.port,
        flag:       cold?.flag,
        lengthM:    cold?.lengthM,
        beamM:      cold?.beamM,
        draftM:     cold?.draftM,
        airHeightM: cold?.airHeightM,
      };
    },
  };
}

export const ais = createAisStore();

