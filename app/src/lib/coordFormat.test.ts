import { describe, expect, it } from 'vitest';
import { formatBearingTrue, formatDm } from './coordFormat';

describe('formatDm', () => {
  // The result is also the default waypoint name persisted to the Signal K
  // server, so it must be plain text that other clients display verbatim.
  it('returns plain text without HTML entities', () => {
    const s = formatDm(59.91, 10.75);
    expect(s).not.toMatch(/&[a-z#0-9]+;/i);
    expect(s).toBe("59°\u202f54.600'\u202fN\u200310°\u202f45.000'\u202fE");
  });

  it('labels southern and western coordinates S/W with unsigned degrees', () => {
    expect(formatDm(-33.86, -151.2)).toBe("33°\u202f51.600'\u202fS\u2003151°\u202f12.000'\u202fW");
  });

  it('carries minutes that round to 60 into the degrees', () => {
    expect(formatDm(59.999995, -10.9999999)).toBe(
      "60°\u202f0.000'\u202fN\u200311°\u202f0.000'\u202fW",
    );
    expect(formatDm(-59.999995, 179.9999999)).toBe(
      "60°\u202f0.000'\u202fS\u2003180°\u202f0.000'\u202fE",
    );
  });

  // MapLibre's click lngLat is unwrapped across the antimeridian (e.g. 180.5).
  // The default waypoint name must describe the same position the server
  // stores, and build_waypoint_body wraps that longitude via
  // geo::canonical_lon (crates/core/src/skrest/waypoints.rs).
  it('names unwrapped longitudes by their canonical hemisphere', () => {
    expect(formatDm(-17, 180.5)).toBe("17°\u202f0.000'\u202fS\u2003179°\u202f30.000'\u202fW");
    expect(formatDm(-17, -180.5)).toBe("17°\u202f0.000'\u202fS\u2003179°\u202f30.000'\u202fE");
    expect(formatDm(10, 370.25)).toBe("10°\u202f0.000'\u202fN\u200310°\u202f15.000'\u202fE");
  });
});

describe('formatBearingTrue', () => {
  it('wraps bearings that round up to 360 back to 000', () => {
    // Initial GC bearing (10.75, 59.91) -> (10.7485, 60.0), just west of north.
    expect(formatBearingTrue(359.5225)).toBe('000° T');
    expect(formatBearingTrue(359.999)).toBe('000° T');
  });

  it('zero-pads and rounds to whole degrees', () => {
    expect(formatBearingTrue(0)).toBe('000° T');
    expect(formatBearingTrue(5.4)).toBe('005° T');
    expect(formatBearingTrue(359.4)).toBe('359° T');
  });
});
