import { describe, expect, it } from 'vitest';
import { chartSourcesToRemove } from './chartLayerTeardown';
import type { Chart, ChartRecord } from './wasmRest';

const RASTER: Chart = { identifier: 'r1', name: 'Raster', url: '/tiles/x/{z}/{x}/{y}', type: 'tilelayer' };
const STYLED: Chart = { identifier: 's1', name: 'Styled', type: 'tilelayer', style: '/style.json' };

describe('chartSourcesToRemove', () => {
  it('keeps a selected tile chart that is in the catalog', () => {
    expect(chartSourcesToRemove(['r1'], new Set(['r1']), { r1: RASTER })).toEqual([]);
  });

  it('removes a mounted chart that was deselected', () => {
    expect(chartSourcesToRemove(['r1'], new Set(), { r1: RASTER })).toEqual(['r1']);
  });

  it('removes a mounted chart whose catalog now gives it a style', () => {
    const catalog: ChartRecord = { s1: STYLED };
    expect(chartSourcesToRemove(['s1'], new Set(['s1']), catalog)).toEqual(['s1']);
  });

  // Server switch: charts.load empties the catalog (and it stays empty if the
  // new server's chart fetch fails). The previous server's layer must not keep
  // rendering its tiles while the pane is connected to the new server.
  it('removes a still-selected mounted chart that left the catalog', () => {
    expect(chartSourcesToRemove(['r1'], new Set(['r1']), {})).toEqual(['r1']);
  });

  it('removes a mounted chart missing from a new, non-empty catalog', () => {
    const catalog: ChartRecord = { b1: { ...RASTER, identifier: 'b1' } };
    expect(chartSourcesToRemove(['r1'], new Set(['r1', 'b1']), catalog)).toEqual(['r1']);
  });
});
