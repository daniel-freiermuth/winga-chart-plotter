import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapViewStore } from './mapView.svelte';
import { createFollowStore } from './follow.svelte';
import { createRotateModeStore } from './rotateMode.svelte';
import { createVisibilityStore } from './visibility.svelte';
import { createBaseLayersStore } from './baseLayers.svelte';
import { createChartSelStore } from './chartSel.svelte';

/**
 * Contract tests for the per-pane store factories: restore from
 * valid/corrupt/absent localStorage, persistence round-trips, exclusivity
 * invariants, and `lsSuffix` key namespacing (pane 0 = legacy un-suffixed
 * keys, pane 1 = ':1').
 */

// Node has no localStorage — install an in-memory Storage per test so the
// factories' persistence paths are actually exercised (their try/catch would
// otherwise silently degrade every test to the fresh-install path).
function memStorage(): Storage {
  const m = new Map<string, string>();
  const storage: Storage = {
    getItem:    (k: string) => m.get(k) ?? null,
    setItem:    (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear:      () => { m.clear(); },
    key:        (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
  return storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memStorage());
});

describe('createMapViewStore', () => {
  it('falls back to the default view on first run, hasSavedView false', () => {
    const v = createMapViewStore();
    expect(v.center).toEqual([10.75, 59.91]);
    expect(v.hasSavedView).toBe(false);
  });

  it('persists via syncView and restores in a fresh instance', () => {
    const v = createMapViewStore();
    v.syncView([5.5, 60.25], 12, 45, 30);
    expect(v.hasSavedView).toBe(true);

    const restored = createMapViewStore();
    expect(restored.center).toEqual([5.5, 60.25]);
    expect(restored.zoom).toBe(12);
    expect(restored.bearing).toBe(45);
    expect(restored.pitch).toBe(30);
    expect(restored.hasSavedView).toBe(true);
  });

  it('treats corrupt storage as first run', () => {
    localStorage.setItem('map-view-coords', '{not json');
    const v = createMapViewStore();
    expect(v.center).toEqual([10.75, 59.91]);
    expect(v.hasSavedView).toBe(false);
  });

  it('restores views persisted before pitch was saved with a flat pitch', () => {
    localStorage.setItem('map-view-coords', '{"center":[1,2],"zoom":9,"bearing":15}');
    const v = createMapViewStore();
    expect(v.bearing).toBe(15);
    expect(v.pitch).toBe(0);
    expect(v.hasSavedView).toBe(true);
  });

  it('namespaces keys by lsSuffix — panes do not share cameras', () => {
    createMapViewStore().syncView([1, 2], 8, 0, 0);
    const pane1 = createMapViewStore(':1');
    expect(pane1.hasSavedView).toBe(false);
    pane1.syncView([3, 4], 9, 10, 0);
    expect(createMapViewStore().center).toEqual([1, 2]);
    expect(createMapViewStore(':1').center).toEqual([3, 4]);
  });

  it('persists projection per pane', () => {
    const v = createMapViewStore();
    v.projection = 'globe';
    expect(createMapViewStore().projection).toBe('globe');
    expect(createMapViewStore(':1').projection).toBe('mercator');
  });
});

describe('createFollowStore', () => {
  it('defaults to not following', () => {
    const f = createFollowStore();
    expect(f.offset).toBeNull();
    expect(f.following).toBe(false);
  });

  it('persists the offset and clears it on null', () => {
    const f = createFollowStore();
    f.offset = { left: 0.5, top: -0.25 };
    expect(createFollowStore().offset).toEqual({ left: 0.5, top: -0.25 });
    f.offset = null;
    expect(createFollowStore().offset).toBeNull();
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem('follow-mode-offset', '"nope"');
    expect(createFollowStore().offset).toBeNull();
  });

  it('namespaces by lsSuffix', () => {
    createFollowStore().offset = { left: 0.1, top: 0.2 };
    expect(createFollowStore(':1').offset).toBeNull();
    expect(createFollowStore().offset).toEqual({ left: 0.1, top: 0.2 });
  });
});

describe('createRotateModeStore', () => {
  it('defaults to north', () => {
    expect(createRotateModeStore().mode).toBe('north');
  });

  it('persists mode and resumeMode across instances', () => {
    const r = createRotateModeStore();
    r.toggleLock(true, true, false); // north → manual, resume north
    expect(r.mode).toBe('manual');
    const restored = createRotateModeStore();
    expect(restored.mode).toBe('manual');
    expect(restored.resumeMode).toBe('north');
  });

  it('treats corrupt storage as north', () => {
    localStorage.setItem('rotate-mode', '{"mode":"sideways"}');
    expect(createRotateModeStore().mode).toBe('north');
  });

  it('namespaces by lsSuffix', () => {
    createRotateModeStore().toggleLock(true, true, false);
    expect(createRotateModeStore(':1').mode).toBe('north');
  });

  it('toggle() cycles through the available auto modes and wraps around', () => {
    const r = createRotateModeStore();
    expect(r.mode).toBe('north');
    r.toggle(true, true, true); expect(r.mode).toBe('cog');
    r.toggle(true, true, true); expect(r.mode).toBe('heading');
    r.toggle(true, true, true); expect(r.mode).toBe('bearing');
    r.toggle(true, true, true); expect(r.mode).toBe('north'); // wraparound
  });

  it('toggle() skips unavailable auto modes', () => {
    const r = createRotateModeStore();
    r.toggle(true, false, false); expect(r.mode).toBe('cog'); // heading/bearing unavailable
    r.toggle(true, false, false); expect(r.mode).toBe('north');
  });

  it('toggle() while manual resumes the remembered auto mode', () => {
    const r = createRotateModeStore();
    r.toggle(true, true, true);     // north → cog
    r.toggleLock(true, true, true); // cog → manual, resume = cog
    expect(r.mode).toBe('manual');
    r.toggle(true, true, true);
    expect(r.mode).toBe('cog');
  });

  it('ensureAvailable() falls back to cog, then north', () => {
    const r = createRotateModeStore();
    r.toggle(true, true, true); r.toggle(true, true, true); // → heading
    r.ensureAvailable(true, false, true);   // heading lost, cog still there
    expect(r.mode).toBe('cog');
    r.ensureAvailable(false, false, false); // everything lost
    expect(r.mode).toBe('north');
    r.ensureAvailable(false, false, false); // stable no-op
    expect(r.mode).toBe('north');
  });
});

describe('createVisibilityStore', () => {
  it('applies defaults on first run', () => {
    const v = createVisibilityStore();
    expect(v.aisVessels).toBe(true);
    expect(v.aisTracks).toBe(false);
  });

  it('persists toggles and merges partial storage with defaults', () => {
    createVisibilityStore().toggle('aisTracks');
    const restored = createVisibilityStore();
    expect(restored.aisTracks).toBe(true);
    expect(restored.routes).toBe(true); // untouched key keeps its default

    localStorage.setItem('layer-visibility', '{"waypoints":false}');
    const partial = createVisibilityStore();
    expect(partial.waypoints).toBe(false);
    expect(partial.ownTrack).toBe(true);
  });

  it('namespaces by lsSuffix', () => {
    createVisibilityStore().toggle('routes');
    expect(createVisibilityStore(':1').routes).toBe(true);
    expect(createVisibilityStore().routes).toBe(false);
  });
});

describe('createBaseLayersStore', () => {
  it('defaults to the first known layer on fresh install', () => {
    expect([...createBaseLayersStore().enabled]).toEqual(['osm']);
  });

  it('toggle is exclusive and persists', () => {
    const b = createBaseLayersStore();
    b.toggle('watercolor');
    expect([...b.enabled]).toEqual(['watercolor']);
    expect([...createBaseLayersStore().enabled]).toEqual(['watercolor']);
  });

  it('deselectAll persists the deliberate empty state', () => {
    const b = createBaseLayersStore();
    b.deselectAll();
    expect([...createBaseLayersStore().enabled]).toEqual([]);
  });

  it('namespaces by lsSuffix', () => {
    createBaseLayersStore().toggle('watercolor');
    expect([...createBaseLayersStore(':1').enabled]).toEqual(['osm']);
  });
});

describe('createChartSelStore', () => {
  it('starts empty and toggle is exclusive', () => {
    const c = createChartSelStore();
    expect(c.selected.size).toBe(0);
    c.toggle('a');
    c.toggle('b');
    expect([...c.selected]).toEqual(['b']);
    expect([...createChartSelStore().selected]).toEqual(['b']);
  });

  it('clamps a legacy multi-id selection to the first id on restore', () => {
    localStorage.setItem('chart-selected', '["a","b","c"]');
    expect([...createChartSelStore().selected]).toEqual(['a']);
  });

  it('skips non-string entries and treats corrupt storage as empty', () => {
    localStorage.setItem('chart-selected', '[42,"b"]');
    expect([...createChartSelStore().selected]).toEqual(['b']);
    localStorage.setItem('chart-selected', '}{');
    expect(createChartSelStore().selected.size).toBe(0);
  });

  it('deselectAll persists the empty selection', () => {
    const c = createChartSelStore();
    c.toggle('a');
    c.deselectAll();
    expect(createChartSelStore().selected.size).toBe(0);
  });

  it('persists WMTS layer selection in the legacy entries format', () => {
    const c = createChartSelStore();
    expect(c.getLayerSel('chart1')).toBe('');
    c.activateLayer('chart1', 'layerA');
    expect(createChartSelStore().getLayerSel('chart1')).toBe('layerA');
    // legacy app-global format is readable as pane 0 data
    expect(localStorage.getItem('chart-wmts-layer-sel')).toBe('[["chart1","layerA"]]');
  });

  it('namespaces selection and layer choice by lsSuffix', () => {
    const p0 = createChartSelStore();
    const p1 = createChartSelStore(':1');
    p0.toggle('a');
    p0.activateLayer('a', 'x');
    p1.toggle('b');
    p1.activateLayer('a', 'y');
    expect([...createChartSelStore().selected]).toEqual(['a']);
    expect([...createChartSelStore(':1').selected]).toEqual(['b']);
    expect(createChartSelStore().getLayerSel('a')).toBe('x');
    expect(createChartSelStore(':1').getLayerSel('a')).toBe('y');
  });
});
