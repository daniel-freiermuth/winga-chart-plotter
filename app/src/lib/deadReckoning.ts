/**
 * Dead reckoning helpers for AIS vessel extrapolation.
 *
 * All math is flat-earth approximation (accurate for <3 min at <20 kts ≈ 1.8 km).
 * The GPU vertex shader in AisHullLayer uses the same formulas for smooth animation.
 */

import type { AisTarget } from '../stores/ais.svelte';

const MAX_DR_SEC = 180;

/**
 * Extrapolate a vessel's position forward from its last known position.
 * Uses arc trajectory when ROT ≠ 0 (circular turn), straight line otherwise.
 * Returns [longitude, latitude].
 */
export function extrapolatePos(
  lon: number, lat: number,
  cogRad: number, sogMs: number, rotRadPerSec: number,
  lastSeenMs: number, nowMs: number,
  maxSec = MAX_DR_SEC,
): [number, number] {
  const dtS = Math.min((nowMs - lastSeenMs) / 1000, maxSec);
  if (dtS === 0 || sogMs < 0.01) return [lon, lat];

  let dEast: number, dNorth: number;
  if (Math.abs(rotRadPerSec) > 1e-4) {
    const cogEnd = cogRad + rotRadPerSec * dtS;
    const R = sogMs / rotRadPerSec;
    dEast  = R * (Math.cos(cogRad) - Math.cos(cogEnd));
    dNorth = R * (Math.sin(cogEnd) - Math.sin(cogRad));
  } else {
    dEast  = sogMs * dtS * Math.sin(cogRad);
    dNorth = sogMs * dtS * Math.cos(cogRad);
  }

  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
  return [lon + dEast / mPerDegLon, lat + dNorth / mPerDegLat];
}

/**
 * Extrapolate a vessel's heading using its rate of turn.
 * Returns heading in radians.
 */
export function extrapolateHeading(
  headingRad: number, rotRadPerSec: number,
  lastSeenMs: number, nowMs: number,
  maxSec = MAX_DR_SEC,
): number {
  const dtS = Math.min((nowMs - lastSeenMs) / 1000, maxSec);
  return headingRad + rotRadPerSec * dtS;
}

/**
 * Compute per-instance icon opacity for the AIS cross-fade.
 * Returns a value in [0, 1]: 1 = full icon, 0 = icon fully faded (hull takes over).
 */
export function vesselIconOpacity(target: AisTarget, zoom: number, settingsIconSize: number): number {
  if (!target.position || !target.lengthM || target.heading === undefined) return 1;
  const { latitude } = target.position;
  const transitionZoom = Math.log2(
    settingsIconSize * 64 * 40075016.686 * Math.cos(latitude * Math.PI / 180)
    / (target.lengthM * 256),
  );
  return 1 - Math.max(0, Math.min(1, (zoom - transitionZoom + 1) / 2));
}

// ---------------------------------------------------------------------------
// Icon rendering helpers (shared between MapLibre own-vessel and deck.gl AIS)
// ---------------------------------------------------------------------------

function drawVesselArrow(ctx: CanvasRenderingContext2D, size: number, color: string): void {
  const cx = size / 2, cy = size / 2, s = size / 32;
  ctx.beginPath();
  ctx.moveTo(cx,         cy - 12 * s); // bow tip
  ctx.lineTo(cx + 8 * s, cy -  4 * s); // starboard shoulder
  ctx.lineTo(cx + 8 * s, cy +  9 * s); // starboard aft
  ctx.lineTo(cx,          cy +  6 * s); // stern notch
  ctx.lineTo(cx - 8 * s, cy +  9 * s); // port aft
  ctx.lineTo(cx - 8 * s, cy -  4 * s); // port shoulder
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5 * s;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/** Draw a vessel arrow icon onto an HTMLCanvasElement and return it. */
export function makeVesselIconCanvas(size: number, color: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D canvas context');
  drawVesselArrow(ctx, size, color);
  return canvas;
}

/** Return ImageData for a vessel arrow icon (used by MapLibre map.addImage / updateImage). */
export function makeVesselIconData(size: number, color: string): ImageData {
  const canvas = makeVesselIconCanvas(size, color);
  return canvas.getContext('2d')!.getImageData(0, 0, size, size);
}

/** Return a data URL for a vessel arrow icon (used as deck.gl IconLayer iconAtlas). */
export function makeVesselIconDataUrl(size: number, color: string): string {
  return makeVesselIconCanvas(size, color).toDataURL();
}
