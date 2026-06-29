import { gcBearingDeg, gcDistanceNm } from '../lib/wasmGeo';

export interface RulerEndpoint {
  lon: number;
  lat: number;
  /** When set, this endpoint follows the live position of the AIS target with this id. */
  snapId?: string;
}

export interface Ruler {
  id: string;
  a: RulerEndpoint;
  b: RulerEndpoint;
}

/** Bearing label for endpoint A: "045° T" */
export function rulerBearingText(r: Ruler): string {
  const bearing = gcBearingDeg(r.a.lon, r.a.lat, r.b.lon, r.b.lat);
  return bearing.toFixed(0).padStart(3, '0') + '° T';
}

/** Distance label for endpoint B: "2.34 NM" */
export function rulerDistanceText(r: Ruler): string {
  const dist = gcDistanceNm(r.a.lon, r.a.lat, r.b.lon, r.b.lat);
  return (dist < 10 ? dist.toFixed(2) : dist.toFixed(1)) + ' NM';
}

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

function createRulersStore() {
  let rulers = $state<Ruler[]>([]);

  return {
    get rulers(): Ruler[] { return rulers; },

    /** Drop a new ruler with explicit endpoint coordinates. */
    add(aLon: number, aLat: number, bLon: number, bLat: number): void {
      rulers = [...rulers, {
        id: uid(),
        a: { lon: aLon, lat: aLat },
        b: { lon: bLon, lat: bLat },
      }];
    },

    remove(id: string): void {
      rulers = rulers.filter(r => r.id !== id);
    },

    moveEndpoint(rulerId: string, endpoint: 'a' | 'b', lon: number, lat: number): void {
      rulers = rulers.map(r => {
        if (r.id !== rulerId) return r;
        const ep: RulerEndpoint = { lon, lat };  // clears snapId on drag
        return { ...r, [endpoint]: ep };
      });
    },

    /** Snap an endpoint to an AIS target. Clears snap if snapId is undefined. */
    snapEndpoint(rulerId: string, endpoint: 'a' | 'b', snapId: string | undefined, lon: number, lat: number): void {
      rulers = rulers.map(r => {
        if (r.id !== rulerId) return r;
        const ep: RulerEndpoint = snapId ? { lon, lat, snapId } : { lon, lat };
        return { ...r, [endpoint]: ep };
      });
    },

    /** Update snapped endpoints from current AIS data (call each rAF). */
    syncSnapped(targets: { id: string; position?: { longitude: number; latitude: number } }[]): void {
      const byId = new Map(targets.map(t => [t.id, t]));
      const next = rulers.map(r => {
        let { a, b } = r;
        if (a.snapId) {
          const t = byId.get(a.snapId);
          if (t?.position && (t.position.longitude !== a.lon || t.position.latitude !== a.lat)) {
            a = { ...a, lon: t.position.longitude, lat: t.position.latitude };
          }
        }
        if (b.snapId) {
          const t = byId.get(b.snapId);
          if (t?.position && (t.position.longitude !== b.lon || t.position.latitude !== b.lat)) {
            b = { ...b, lon: t.position.longitude, lat: t.position.latitude };
          }
        }
        return (a !== r.a || b !== r.b) ? { ...r, a, b } : r;
      });
      if (next.some((r, i) => r !== rulers[i])) rulers = next;
    },
  };
}

export const rulers = createRulersStore();
