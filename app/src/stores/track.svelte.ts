import { vesselState } from './vessel';
import { fetchTrack } from '../lib/wasmRest';

// ~5 metres in degrees² — fast planar approximation, good enough for this threshold
const MIN_DIST_SQ_DEG = (5 / 111_320) ** 2;

/**
 * Returns the shortest-path delta from `prev` to `lon` (in degrees, ±180 range).
 * Used only for the duplicate-point distance filter — coordinates are always stored raw.
 */
function shortestLonDelta(lon: number, prev: number): number {
  return ((lon - prev + 180) % 360 + 360) % 360 - 180;
}

function createTrack() {
  let _coords = $state<[number, number][]>([]);
  let _lastLon = 0;
  let _lastLat = 0;
  let _hasLast = false;
  let _unsub: (() => void) | null = null;

  function append(lon: number, lat: number): void {
    if (_hasLast) {
      // Shortest-path delta for the duplicate-point filter; coords are stored raw.
      const dLon = shortestLonDelta(lon, _lastLon);
      const dLat = lat - _lastLat;
      if (dLon * dLon + dLat * dLat < MIN_DIST_SQ_DEG) return;
    }
    _hasLast = true;
    _lastLon = lon;  // raw [-180, 180] — rendering unwraps on-the-fly
    _lastLat = lat;
    _coords.push([lon, lat]);
  }

  return {
    get coordinates(): [number, number][] { return _coords; },

    async init(serverBase: string, historyHours = 24): Promise<void> {
      _unsub?.();
      _coords = [];
      _hasLast = false;

      if (historyHours > 0) {
        try {
          const historical = await fetchTrack(serverBase, historyHours);
          _coords = historical;  // raw coords from server, unwrapped at render time
          if (historical.length > 0) {
            [_lastLon, _lastLat] = historical[historical.length - 1] as [number, number];
            _hasLast = true;
          }
        } catch (err) {
          console.warn('[track] Could not fetch historical track:', err);
        }
      }

      _unsub = vesselState.subscribe(state => {
        if (!state.position) return;
        append(state.position.longitude, state.position.latitude);
      });
    },

    clear(): void {
      _coords = [];
      _hasLast = false;
    },

    destroy(): void {
      _unsub?.();
      _unsub = null;
    },
  };
}

export const track = createTrack();
