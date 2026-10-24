/**
 * Bookkeeping for all-AIS-tracks mode: when each vessel's server history is (re)fetched,
 * and how a cached track is kept attached to the vessel's live position between fetches.
 */

/** A vessel's server history is refetched this long after its last successful fetch. */
export const AIS_TRACK_REFRESH_MS = 5 * 60_000;
/** A vessel whose history fetch failed is retried after this delay. */
export const AIS_TRACK_RETRY_MS = 30_000;
/** Minimum interval between extending all cached tracks to the vessels' live positions. */
export const AIS_TRACK_LIVE_EXTEND_MS = 5_000;

/** Squared-degree distance (~5 m) under which a live point duplicates the track end (matches server-side dedup). */
const LIVE_POINT_DEDUP_SQ = 2.02e-9;

/**
 * Per-vessel fetch schedule. A vessel is due when it has no entry or its next-fetch time has
 * passed; dispatching marks it in flight (never due) until `succeeded`/`failed` reschedules it.
 */
export class AisTrackFetchSchedule {
  readonly #nextAt = new Map<string, number>();

  get size(): number { return this.#nextAt.size; }

  /** Whether `id` is still tracked (in flight or scheduled), i.e. not evicted or cleared. */
  has(id: string): boolean { return this.#nextAt.has(id); }

  /** Returns the ids in `ids` that are due at `now` and marks them in flight. */
  takeDue(ids: readonly string[], now: number): string[] {
    const due: string[] = [];
    for (const id of ids) {
      const at = this.#nextAt.get(id);
      if (at !== undefined && at > now) continue;
      this.#nextAt.set(id, Infinity);
      due.push(id);
    }
    return due;
  }

  /** Schedules the next refresh of `id`; no-op if it was evicted while in flight. */
  succeeded(id: string, now: number): void {
    if (this.#nextAt.has(id)) this.#nextAt.set(id, now + AIS_TRACK_REFRESH_MS);
  }

  /** Schedules a retry of `id`; no-op if it was evicted while in flight. */
  failed(id: string, now: number): void {
    if (this.#nextAt.has(id)) this.#nextAt.set(id, now + AIS_TRACK_RETRY_MS);
  }

  /** Forgets every vessel not in `keep`; returns the evicted ids. */
  retain(keep: ReadonlySet<string>): string[] {
    const evicted: string[] = [];
    for (const id of this.#nextAt.keys()) {
      if (!keep.has(id)) evicted.push(id);
    }
    for (const id of evicted) this.#nextAt.delete(id);
    return evicted;
  }

  clear(): void { this.#nextAt.clear(); }
}

/**
 * Returns `coords` extended by the live position `[lon, lat]`, or `coords` itself when the
 * position is invalid or within ~5 m of the track's last point. Never mutates `coords`.
 */
export function appendLivePoint(coords: [number, number][], lon: number, lat: number): [number, number][] {
  if (isNaN(lon) || isNaN(lat)) return coords;
  const last = coords[coords.length - 1];
  if (last) {
    const dx = last[0] - lon;
    const dy = last[1] - lat;
    if (dx * dx + dy * dy < LIVE_POINT_DEDUP_SQ) return coords;
  }
  return [...coords, [lon, lat]];
}

/**
 * Track to cache after a history fetch: the fetched history when it is drawable (≥ 2 points),
 * otherwise the existing cached track (so a server without history does not wipe the track
 * grown from live positions), extended to the live position.
 */
export function refreshedTrack(
  fetched: [number, number][],
  cached: [number, number][] | undefined,
  lon: number,
  lat: number,
): [number, number][] {
  const base = fetched.length >= 2 || !cached ? fetched : cached;
  return appendLivePoint(base, lon, lat);
}
