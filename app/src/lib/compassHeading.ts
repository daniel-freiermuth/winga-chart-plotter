const DEG_TO_RAD = Math.PI / 180;

// DeviceOrientation angles are in the device frame: they give the bearing of the
// device's natural (usually portrait) top edge and do not change when the screen
// rotates. `screenAngleDeg` (screen.orientation.angle) is how far the screen
// content is rotated from that frame, so adding it yields the bearing of the
// screen's "up" edge — the heading the chart and own-vessel icon need.

function bearingToRad(bearingDeg: number): number {
  return (((bearingDeg % 360) + 360) % 360) * DEG_TO_RAD;
}

/**
 * Compass heading (radians in [0, 2π), CW from north) of the screen's "up" edge
 * from a DeviceOrientation `alpha` (degrees, CCW rotation from north).
 */
export function headingFromAlpha(alpha: number, screenAngleDeg: number): number {
  return bearingToRad(360 - alpha + screenAngleDeg);
}

/**
 * Compass heading (radians in [0, 2π), CW from north) of the screen's "up" edge
 * from iOS `webkitCompassHeading` (degrees, CW bearing of the device top edge).
 */
export function headingFromWebkitCompass(webkitHeading: number, screenAngleDeg: number): number {
  return bearingToRad(webkitHeading + screenAngleDeg);
}
