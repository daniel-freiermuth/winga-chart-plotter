const DEG_TO_RAD = Math.PI / 180;

/**
 * Compass heading (radians, CW from north) of the screen's "up" edge from a
 * DeviceOrientation `alpha` (degrees, CCW rotation from north).
 */
export function headingFromAlpha(alpha: number, _screenAngleDeg: number): number {
  return ((360 - alpha) % 360) * DEG_TO_RAD;
}

/**
 * Compass heading (radians, CW from north) of the screen's "up" edge from iOS
 * `webkitCompassHeading` (degrees, CW bearing from north).
 */
export function headingFromWebkitCompass(webkitHeading: number, _screenAngleDeg: number): number {
  return webkitHeading * DEG_TO_RAD;
}
