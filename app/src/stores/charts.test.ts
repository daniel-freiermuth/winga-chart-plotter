import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memStorage } from './testStorage';
import type { Chart } from '../lib/wasmRest';

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
