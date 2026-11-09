import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memStorage } from './testStorage';
import type { Chart, ChartRecord } from '../lib/wasmRest';
import type { WmtsInfo } from '../lib/wmts';

/**
 * WMTS tile URLs must follow the resolved capabilities and the pane's layer
 * selection. The picker no longer offers a manual URL override (removed in the
 * chart-picker overhaul), so a value persisted under the old
 * 'chart-wmts-overrides' key must not pin a chart's tiles: nothing in the app
 * could change or clear it.
 *
 * The charts singleton reads localStorage at module load, so each test resets
 * the module registry and re-imports with a fresh in-memory storage.
 */

const CHART: Chart = {
  identifier: 'w1',
  name: 'WMTS chart',
  url: 'https://wmts.example/capabilities',
  format: 'png',
  type: 'WMTS',
};

const COAST_URL   = 'https://wmts.example/coast/{z}/{x}/{y}.png';
const HARBOUR_URL = 'https://wmts.example/harbour/{z}/{x}/{y}.png';
const LAYERS = [
  { id: 'coast',   title: 'Coast',   tileUrl: COAST_URL },
  { id: 'harbour', title: 'Harbour', tileUrl: HARBOUR_URL },
];

vi.mock('../lib/wasmRest', () => ({
  fetchCharts: vi.fn(() => Promise.resolve({ w1: CHART })),
  buildTileUrl: vi.fn(() => ''),
}));

vi.mock('../lib/wmts', () => ({
  resolveWmtsTileUrl: vi.fn(() => Promise.resolve({
    tileUrlTemplate: COAST_URL,
    layerName: 'coast',
    availableLayers: LAYERS,
  })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', memStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('charts.tileUrl with a stale persisted WMTS override', () => {
  it('follows the pane layer and the resolved default, not the orphaned override', async () => {
    localStorage.setItem(
      'chart-wmts-overrides',
      JSON.stringify([['w1', 'https://stale.invalid/{z}/{x}/{y}.png']]),
    );
    // Dynamic import: the singleton reads localStorage at module load (see header).
    const { charts } = await import('./charts.svelte');

    await charts.load('http://sk.local');
    await vi.waitFor(() => { expect(charts.wmtsResolving.has('w1')).toBe(false); });

    expect(charts.tileUrl(CHART, 'harbour')).toBe(HARBOUR_URL);
    expect(charts.tileUrl(CHART)).toBe(COAST_URL);
  });
});

describe('charts.visibleLayers with a layers hint naming only unusable layers', () => {
  it('still offers a selectable Web Mercator layer instead of only disabled cards', async () => {
    // 'wgs-only' links no Web Mercator TileMatrixSet → tileUrl '' (picker
    // renders it as a disabled card). resolveWmtsTileUrl falls back to the
    // first Web Mercator layer for the default URL.
    const hinted: Chart = { ...CHART, layers: ['wgs-only'] };
    const { fetchCharts } = await import('../lib/wasmRest');
    const { resolveWmtsTileUrl } = await import('../lib/wmts');
    vi.mocked(fetchCharts).mockResolvedValueOnce({ w1: hinted });
    vi.mocked(resolveWmtsTileUrl).mockResolvedValueOnce({
      tileUrlTemplate: COAST_URL,
      layerName: 'coast',
      tileMatrixSet: 'GoogleMapsCompatible',
      format: 'image/png',
      availableLayers: [{ id: 'wgs-only', title: 'WGS only', tileUrl: '' }, ...LAYERS],
    });
    const { charts } = await import('./charts.svelte');

    await charts.load('http://sk.local');
    await vi.waitFor(() => { expect(charts.wmtsResolving.has('w1')).toBe(false); });

    const selectable = charts.visibleLayers('w1').filter(l => l.tileUrl !== '');
    expect(selectable.map(l => l.id)).toContain('coast');
  });
});

describe('charts.styleUrl for a Signal K mapstyleJSON chart', () => {
  it('uses the style document carried in url when no vendor style field is set', async () => {
    const { charts } = await import('./charts.svelte');
    await charts.load('http://sk.local');
    const chart: Chart = { identifier: 'a', name: 'a', type: 'mapstyleJSON', url: '/s.json' };
    expect(charts.styleUrl(chart)).toBe('http://sk.local/s.json');
  });
});

/**
 * Switching Signal K servers must not leave the previous server's catalog in
 * `available`: its relative tile/style paths would be resolved against the
 * NEW base (tileUrl/styleUrl use the current server base), and Map.svelte
 * renders selected charts from `available` without consulting `error`.
 */
describe('charts.load across a server switch', () => {
  const RASTER: Chart = { identifier: 'r1', name: 'Raster', url: '/tiles/x/{z}/{x}/{y}', type: 'tilelayer' };

  it('drops the old server catalog when the new server fetch fails', async () => {
    const { fetchCharts } = await import('../lib/wasmRest');
    vi.mocked(fetchCharts)
      .mockResolvedValueOnce({ r1: RASTER })
      .mockRejectedValueOnce(new Error('503'));
    const { charts } = await import('./charts.svelte');

    await charts.load('http://a');
    expect(charts.available).toEqual({ r1: RASTER });
    await charts.load('http://b');

    expect(charts.error).toContain('503');
    expect(charts.available).toEqual({});
  });

  it('keeps the last good catalog when the same server fetch fails', async () => {
    const { fetchCharts } = await import('../lib/wasmRest');
    vi.mocked(fetchCharts)
      .mockResolvedValueOnce({ r1: RASTER })
      .mockRejectedValueOnce(new Error('503'));
    const { charts } = await import('./charts.svelte');

    await charts.load('http://a');
    await charts.load('http://a');

    expect(charts.available).toEqual({ r1: RASTER });
  });

  it('ignores a slow response from the previous server', async () => {
    const { fetchCharts } = await import('../lib/wasmRest');
    const pendingA = Promise.withResolvers<ChartRecord>();
    vi.mocked(fetchCharts)
      .mockReturnValueOnce(pendingA.promise)
      .mockResolvedValueOnce({ b1: { ...RASTER, identifier: 'b1' } });
    const { charts } = await import('./charts.svelte');

    const loadA = charts.load('http://a');
    await charts.load('http://b');
    pendingA.resolve({ r1: RASTER });
    await loadA;

    expect(Object.keys(charts.available)).toEqual(['b1']);
    expect(charts.loading).toBe(false);
  });

  it('forgets WMTS resolutions from the previous server', async () => {
    const { fetchCharts } = await import('../lib/wasmRest');
    vi.mocked(fetchCharts)
      .mockResolvedValueOnce({ w1: CHART })
      .mockRejectedValueOnce(new Error('503'));
    const { charts } = await import('./charts.svelte');

    await charts.load('http://a');
    await vi.waitFor(() => { expect(charts.wmtsResolving.has('w1')).toBe(false); });
    expect(charts.tileUrl(CHART)).toBe(COAST_URL);

    await charts.load('http://b');

    expect(charts.tileUrl(CHART)).toBe('');
    expect(charts.visibleLayers('w1')).toEqual([]);
  });

  // The switch happens while the previous server's capabilities request is
  // still in flight: its late outcome must not land in the new server's caches.
  const A_INFO: WmtsInfo = {
    tileUrlTemplate: COAST_URL,
    layerName: 'coast',
    tileMatrixSet: 'GoogleMapsCompatible',
    format: 'image/png',
    availableLayers: LAYERS,
  };

  it('drops a WMTS resolution from the previous server that lands after the switch', async () => {
    const { fetchCharts } = await import('../lib/wasmRest');
    const { resolveWmtsTileUrl } = await import('../lib/wmts');
    const pendingA = Promise.withResolvers<WmtsInfo>();
    vi.mocked(fetchCharts)
      .mockResolvedValueOnce({ w1: CHART })
      .mockRejectedValueOnce(new Error('503'));
    vi.mocked(resolveWmtsTileUrl).mockReturnValueOnce(pendingA.promise);
    const { charts } = await import('./charts.svelte');

    await charts.load('http://a');
    expect(charts.wmtsResolving.has('w1')).toBe(true);
    await charts.load('http://b');
    pendingA.resolve(A_INFO);
    await pendingA.promise;
    await Promise.resolve();

    expect(charts.tileUrl(CHART)).toBe('');
    expect(charts.visibleLayers('w1')).toEqual([]);
    expect(charts.wmtsResolving.has('w1')).toBe(false);
  });

  it('drops a WMTS failure from the previous server that lands after the switch', async () => {
    const { fetchCharts } = await import('../lib/wasmRest');
    const { resolveWmtsTileUrl } = await import('../lib/wmts');
    const pendingA = Promise.withResolvers<WmtsInfo>();
    vi.mocked(fetchCharts)
      .mockResolvedValueOnce({ w1: CHART })
      .mockRejectedValueOnce(new Error('503'));
    vi.mocked(resolveWmtsTileUrl).mockReturnValueOnce(pendingA.promise);
    const { charts } = await import('./charts.svelte');

    await charts.load('http://a');
    await charts.load('http://b');
    pendingA.reject(new Error('capabilities 500'));
    await expect(pendingA.promise).rejects.toThrow('capabilities 500');
    await Promise.resolve();

    expect(charts.wmtsFailed.has('w1')).toBe(false);
  });

  // A→B→A: the first A resolution settling must not clear the resolving flag
  // of the second A resolution, or the picker reports the chart as failed
  // while its capabilities are still loading.
  it('keeps the current resolving flag when a superseded resolution settles', async () => {
    const { fetchCharts } = await import('../lib/wasmRest');
    const { resolveWmtsTileUrl } = await import('../lib/wmts');
    const firstA = Promise.withResolvers<WmtsInfo>();
    const secondA = Promise.withResolvers<WmtsInfo>();
    vi.mocked(fetchCharts)
      .mockResolvedValueOnce({ w1: CHART })
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ w1: CHART });
    vi.mocked(resolveWmtsTileUrl)
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(secondA.promise);
    const { charts } = await import('./charts.svelte');

    await charts.load('http://a');
    await charts.load('http://b');
    await charts.load('http://a');
    firstA.reject(new Error('capabilities 500'));
    await expect(firstA.promise).rejects.toThrow('capabilities 500');
    await Promise.resolve();

    expect(charts.wmtsResolving.has('w1')).toBe(true);
    expect(charts.wmtsFailed.has('w1')).toBe(false);

    secondA.resolve(A_INFO);
    await vi.waitFor(() => { expect(charts.wmtsResolving.has('w1')).toBe(false); });
    expect(charts.tileUrl(CHART)).toBe(COAST_URL);
  });
});
