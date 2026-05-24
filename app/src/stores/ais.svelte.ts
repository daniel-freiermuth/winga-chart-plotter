import type { VesselInfo } from '../lib/signalk-api';

export interface AisTarget {
  id: string;
  mmsi?: string;
  name?: string;
  position?: { longitude: number; latitude: number; altitude?: number };
  cog?: number;
  sog?: number;
  heading?: number;
  rot?: number;
  stw?: number;
  /** Epoch ms of the last received position update (wall-clock time on receive). */
  lastPositionUpdateMs: number;
  // enriched from REST API
  shipType?: string;
  lengthM?: number;
  beamM?: number;
  draftM?: number;
}

// Raw data from WASM — same shape as AisTarget (no store-added fields).
type RawTarget = AisTarget;

function createAisStore() {
  let targets = $state<AisTarget[]>([]);
  let infoCache = new Map<string, VesselInfo>();

  function enrich(t: RawTarget): AisTarget {
    const info = infoCache.get(t.id);
    if (!info) return t;
    const enriched: AisTarget = { ...t };
    if (!enriched.name     && info.name)     enriched.name     = info.name;
    if (!enriched.shipType && info.shipType) enriched.shipType = info.shipType;
    if (!enriched.lengthM  && info.lengthM)  enriched.lengthM  = info.lengthM;
    if (!enriched.beamM    && info.beamM)    enriched.beamM    = info.beamM;
    if (!enriched.draftM   && info.draftM)   enriched.draftM   = info.draftM;
    return enriched;
  }

  return {
    get targets(): AisTarget[] { return targets; },

    setInfoCache(map: Map<string, VesselInfo>) {
      infoCache = map;
      if (targets.length > 0) targets = targets.map(t => enrich(t));
    },

    update(incoming: RawTarget[]) {
      targets = incoming.map(raw => enrich(raw));
    },
  };
}

export const ais = createAisStore();
