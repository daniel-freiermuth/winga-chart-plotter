import type { LineStyle } from '../stores/settings.svelte';

/** Convert a CSS hex colour to an [r, g, b, a] tuple where alpha is 0–255. */
export function hexToRgba(hex: string, alpha = 255): [number, number, number, number] {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [isNaN(r) ? 0 : r, isNaN(g) ? 0 : g, isNaN(b) ? 0 : b, alpha];
}

/**
 * Map a LineStyle + line width to a PathStyleExtension dash array [dashPx, gapPx].
 * Values are in pixels (same units as widthUnits: 'pixels').
 * Pattern scales with width so dots stay circular and dashes stay proportional.
 */
export function lineStyleDash(style: LineStyle, width: number): [number, number] {
  const w = Math.max(1, width);
  switch (style) {
    case 'dashed':   return [6 * w, 3 * w];
    case 'dotted':   return [w,     2 * w];  // dot ≈ square/circular, gap = 2× width
    case 'dash-dot': return [6 * w, 2 * w];  // deck.gl only supports two-element arrays
    default:         return [0, 0];
  }
}

/**
 * Map a LineStyle + line width to a MapLibre `line-dasharray` value.
 * Returns null for solid lines — callers must pass null to setPaintProperty / omit from addLayer paint.
 * MapLibre requires all dasharray values to be > 0; [1, 0] is invalid and causes worker errors.
 */
export function dashArray(style: LineStyle, width: number): number[] | null {
  const w = Math.max(1, width);
  switch (style) {
    case 'dashed':   return [5, 3];
    case 'dotted':   return [w, 3];
    case 'dash-dot': return [5, 3, 1, 3];
    default:         return null; // solid — no dasharray
  }
}
