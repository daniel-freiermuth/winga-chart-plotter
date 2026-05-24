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
  /** Epoch ms of the last observed position change. Always set by the store after first update. */
  lastSeen: number;
  // enriched from REST API
  shipType?: string;
  lengthM?: number;
  beamM?: number;
  draftM?: number;
}

// Raw data from WASM — identical to AisTarget but without lastSeen (added by the store).
type RawTarget = Omit<AisTarget, 'lastSeen'>;

function createAisStore() {
  let targets = $state<AisTarget[]>([]);
  let infoCache = new Map<string, VesselInfo>();
  // Track last-known position per vessel to detect movement.
  const prevPos = new Map<string, { lon: number; lat: number }>();

  function enrich(t: RawTarget): RawTarget {
    const info = infoCache.get(t.id);
    if (!info) return t;
    const enriched: RawTarget = { ...t };
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
      if (targets.length > 0) targets = targets.map(t => ({ ...enrich(t), lastSeen: t.lastSeen }));
    },

    update(incoming: RawTarget[]) {
      const now = Date.now();
      const prevSeen = new Map<string, number>(targets.map(t => [t.id, t.lastSeen]));

      targets = incoming.map(raw => {
        const t = enrich(raw);
        let lastSeen = prevSeen.get(t.id) ?? now;

        if (t.position) {
          const { longitude, latitude } = t.position;
          const prev = prevPos.get(t.id);
          if (!prev || Math.abs(longitude - prev.lon) > 1e-7 || Math.abs(latitude - prev.lat) > 1e-7) {
            lastSeen = now;
            prevPos.set(t.id, { lon: longitude, lat: latitude });
          }
        }

        return { ...t, lastSeen };
      });

      // Remove stale entries from position tracker
      const incoming_ids = new Set(incoming.map(t => t.id));
      for (const id of prevPos.keys()) {
        if (!incoming_ids.has(id)) prevPos.delete(id);
      }
    },
  };
}

export const ais = createAisStore();
