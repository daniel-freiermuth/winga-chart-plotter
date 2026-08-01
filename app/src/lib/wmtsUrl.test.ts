import { describe, expect, it } from 'vitest';
import { pickWmtsTileUrl } from './wmtsUrl';
import type { WmtsLayerInfo } from './wmts';

const LAYERS: WmtsLayerInfo[] = [
  { id: 'seamap',  title: 'Sea map',  tileUrl: 'https://wmts.example/seamap/{z}/{x}/{y}.png' },
  { id: 'harbour', title: 'Harbour',  tileUrl: 'https://wmts.example/harbour/{z}/{x}/{y}.png' },
  { id: 'broken',  title: 'No URL',   tileUrl: '' },
];
const DEFAULT_URL = 'https://wmts.example/default/{z}/{x}/{y}.png';

describe('pickWmtsTileUrl', () => {
  it('manual override wins over everything', () => {
    expect(pickWmtsTileUrl('https://manual/{z}/{x}/{y}', LAYERS, 'harbour', DEFAULT_URL))
      .toBe('https://manual/{z}/{x}/{y}');
  });

  it("returns the pane's selected layer URL", () => {
    expect(pickWmtsTileUrl(undefined, LAYERS, 'harbour', DEFAULT_URL))
      .toBe('https://wmts.example/harbour/{z}/{x}/{y}.png');
  });

  it('falls back to the resolved default when the pane layer is unknown', () => {
    expect(pickWmtsTileUrl(undefined, LAYERS, 'gone', DEFAULT_URL)).toBe(DEFAULT_URL);
  });

  it('falls back when the selected layer has no usable URL', () => {
    expect(pickWmtsTileUrl(undefined, LAYERS, 'broken', DEFAULT_URL)).toBe(DEFAULT_URL);
  });

  it('uses the resolved default when the pane has no layer choice', () => {
    expect(pickWmtsTileUrl(undefined, LAYERS, undefined, DEFAULT_URL)).toBe(DEFAULT_URL);
  });

  it('degrades to an empty URL before capabilities resolve', () => {
    expect(pickWmtsTileUrl(undefined, undefined, 'harbour', undefined)).toBe('');
  });
});
