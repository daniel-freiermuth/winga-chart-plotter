/** CPA data published by a Signal K plugin under `navigation.closestApproach`. */
export interface SkClosestApproach {
  /** Closest point of approach distance, metres. */
  distanceM: number;
  /** Time to closest point of approach, seconds. */
  timeToS: number;
}

/**
 * Merge an incoming `skCpa` value from a Signal K delta batch into the cached one.
 *
 * `null` is an explicit retraction from the server — clear the cached value.
 * Only a genuinely absent field (`undefined`) retains the previous value.
 */
export function mergeSkCpa(
  next: SkClosestApproach | null | undefined,
  existing: SkClosestApproach | undefined,
): SkClosestApproach | undefined {
  if (next === null) return undefined;
  return next ?? existing;
}
