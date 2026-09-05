/**
 * Dead reckoning helpers for AIS vessel extrapolation.
 *
 * All math is flat-earth approximation (accurate for <3 min at <20 kts ≈ 1.8 km).
 * The GPU vertex shader in VesselMorphLayer uses the same formulas for smooth animation.
 */

import type { AisTarget } from '../stores/ais.svelte';

/**
 * Return the best epoch-ms timestamp for a target's last position fix.
 */
export function positionUpdateMs(t: AisTarget): number {
  return t.lastPositionUpdateMs;
}

/**
 * Extrapolate a vessel's position forward from its last known position.
 * Uses arc trajectory when ROT ≠ 0 (circular turn), straight line otherwise.
 * Returns [longitude, latitude].
 */
export function extrapolatePos(
  lon: number, lat: number,
  cogRad: number, sogMs: number, rotRadPerSec: number,
  lastSeenMs: number, nowMs: number,
): [number, number] {
  const dtS = (nowMs - lastSeenMs) / 1000;
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
): number {
  const dtS = (nowMs - lastSeenMs) / 1000;
  return headingRad + rotRadPerSec * dtS;
}

