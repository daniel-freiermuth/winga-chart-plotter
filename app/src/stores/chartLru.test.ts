import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memStorage } from './testStorage';

/**
 * touchVisibleSelections() must record exactly the VISIBLE panes' active
 * base layers and charts in the LRU — selections with a WMTS layer under
 * `${chartId}:${layerId}`, everything else under its plain id. Which panes
 * are visible follows the pane layout (visiblePanesFor).
 *
 * The key shape derives from the pane's own selection state, never from the
 * chart catalog — these tests deliberately run with the catalog UNLOADED
 * (charts.available is empty), pinning that a WMTS selection stays fresh
 * under its composite key even when its chart is missing from the catalog
 * (fetch still in flight, or chart dropped server-side).
 *
 * The pane/settings/chartLru singletons initialize at module load, so every
 * test resets the module registry and re-imports with a fresh in-memory
 * localStorage (same pattern as paneSeeding.test.ts).
 */

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', memStorage());
  // settings.svelte.ts detects the Signal K origin from window.location at module init.
  vi.stubGlobal('window', { location: new URL('http://localhost:5173/') });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Persist a two-pane selection fixture and import the module under test. */
async function boot(paneLayout: 'split' | 'solo0' | 'solo1') {
  localStorage.setItem('signalk-chart-settings', JSON.stringify({ paneLayout }));
  // Pane 0: one active base layer + a WMTS chart with a picked layer.
  localStorage.setItem('base-layers-enabled', JSON.stringify(['osm']));
  localStorage.setItem('chart-selected', JSON.stringify(['w1']));
  localStorage.setItem('chart-wmts-layer-sel', JSON.stringify([['w1', 'layerA']]));
  // Pane 1: no base layer (deliberate '[]') + one plain chart.
  localStorage.setItem('base-layers-enabled:1', JSON.stringify([]));
  localStorage.setItem('chart-selected:1', JSON.stringify(['c1']));
  return await import('./chartLru.svelte');
}

describe('touchVisibleSelections', () => {
  it('split: records both panes — base layer, WMTS chart:layer key, plain chart id', async () => {
    const { chartLru, touchVisibleSelections } = await boot('split');

    touchVisibleSelections();

    expect(chartLru.rank('osm')).toBeGreaterThan(0);
    expect(chartLru.rank('w1:layerA')).toBeGreaterThan(0);
    expect(chartLru.rank('c1')).toBeGreaterThan(0);
    // WMTS charts key as chart:layer, never as the bare chart id.
    expect(chartLru.rank('w1')).toBe(0);
  });

  it('solo0: records only pane 0', async () => {
    const { chartLru, touchVisibleSelections } = await boot('solo0');

    touchVisibleSelections();

    expect(chartLru.rank('osm')).toBeGreaterThan(0);
    expect(chartLru.rank('w1:layerA')).toBeGreaterThan(0);
    expect(chartLru.rank('c1')).toBe(0);
  });

  it('solo1: records only pane 1', async () => {
    const { chartLru, touchVisibleSelections } = await boot('solo1');

    touchVisibleSelections();

    expect(chartLru.rank('c1')).toBeGreaterThan(0);
    expect(chartLru.rank('osm')).toBe(0);
    expect(chartLru.rank('w1:layerA')).toBe(0);
  });
});
