import { describe, expect, it } from 'vitest';
import {
  AIS_TRACK_REFRESH_MS,
  AIS_TRACK_RETRY_MS,
  AisTrackFetchSchedule,
  appendLivePoint,
  refreshedTrack,
} from './aisAllTracks';

describe('AisTrackFetchSchedule', () => {
  it('dispatches each new vessel once while its fetch is in flight', () => {
    const s = new AisTrackFetchSchedule();
    expect(s.takeDue(['a', 'b'], 0)).toEqual(['a', 'b']);
    // In flight: neither a later batch nor a long wait re-dispatches it.
    expect(s.takeDue(['a', 'b'], 1)).toEqual([]);
    expect(s.takeDue(['a', 'b'], AIS_TRACK_REFRESH_MS * 10)).toEqual([]);
  });

  it('refetches a vessel that stays in range once its track is stale', () => {
    const s = new AisTrackFetchSchedule();
    s.takeDue(['a'], 0);
    s.succeeded('a', 1_000);
    expect(s.takeDue(['a'], 1_000 + AIS_TRACK_REFRESH_MS - 1)).toEqual([]);
    expect(s.takeDue(['a'], 1_000 + AIS_TRACK_REFRESH_MS)).toEqual(['a']);
  });

  it('retries a vessel whose fetch failed instead of never fetching it again', () => {
    const s = new AisTrackFetchSchedule();
    s.takeDue(['a'], 0);
    s.failed('a', 1_000);
    expect(s.takeDue(['a'], 1_000 + AIS_TRACK_RETRY_MS - 1)).toEqual([]);
    expect(s.takeDue(['a'], 1_000 + AIS_TRACK_RETRY_MS)).toEqual(['a']);
  });

  it('evicts vessels that left the target list and reports them', () => {
    const s = new AisTrackFetchSchedule();
    s.takeDue(['a', 'b'], 0);
    expect(s.retain(new Set(['b']))).toEqual(['a']);
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(true);
    // A result for an evicted vessel must not resurrect its schedule entry.
    s.succeeded('a', 1);
    s.failed('a', 1);
    expect(s.has('a')).toBe(false);
    // Coming back into range makes it due immediately.
    expect(s.takeDue(['a', 'b'], 2)).toEqual(['a']);
  });

  it('clear() forgets every vessel', () => {
    const s = new AisTrackFetchSchedule();
    s.takeDue(['a'], 0);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.takeDue(['a'], 0)).toEqual(['a']);
  });
});

describe('appendLivePoint', () => {
  it('extends the track to a vessel that moved', () => {
    const track: [number, number][] = [[0, 0], [0, 0.001]];
    expect(appendLivePoint(track, 0, 0.002)).toEqual([[0, 0], [0, 0.001], [0, 0.002]]);
    // Input is not mutated (cached track arrays are shared with the render path).
    expect(track).toHaveLength(2);
  });

  it('returns the same array when the vessel has not moved ~5 m', () => {
    const track: [number, number][] = [[0, 0], [0, 0.001]];
    expect(appendLivePoint(track, 0, 0.001 + 1e-5)).toBe(track);
  });

  it('ignores an invalid live position', () => {
    const track: [number, number][] = [[0, 0]];
    expect(appendLivePoint(track, NaN, 1)).toBe(track);
    expect(appendLivePoint(track, 1, NaN)).toBe(track);
  });

  it('starts a track from the live position when there is no history', () => {
    expect(appendLivePoint([], 1, 2)).toEqual([[1, 2]]);
  });
});

describe('refreshedTrack', () => {
  it('replaces the cached track with fresh server history ending at the vessel', () => {
    const cached: [number, number][] = [[0, 0], [0, 0.001]];
    const fetched: [number, number][] = [[0, 0], [0, 0.001], [0, 0.002]];
    expect(refreshedTrack(fetched, cached, 0, 0.003)).toEqual([[0, 0], [0, 0.001], [0, 0.002], [0, 0.003]]);
  });

  it('keeps the locally extended track when the server has no usable history', () => {
    const cached: [number, number][] = [[0, 0], [0, 0.001]];
    expect(refreshedTrack([], cached, 0, 0.002)).toEqual([[0, 0], [0, 0.001], [0, 0.002]]);
    expect(refreshedTrack([[5, 5]], cached, 0, 0.002)).toEqual([[0, 0], [0, 0.001], [0, 0.002]]);
  });

  it('seeds a new vessel without server history from its live position', () => {
    expect(refreshedTrack([], undefined, 1, 2)).toEqual([[1, 2]]);
  });
});
