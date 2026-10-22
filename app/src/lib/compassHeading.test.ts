import { describe, expect, it } from 'vitest';
import { headingFromAlpha, headingFromWebkitCompass } from './compassHeading';

const deg = (d: number) => d * (Math.PI / 180);

// DeviceOrientation angles are in the device frame (natural/portrait top edge);
// screen.orientation.angle is how far the screen content is rotated from it.
// The heading the chart needs is the bearing of the screen's "up" edge.
describe('headingFromAlpha', () => {
  it('portrait: flips the CCW alpha to a CW bearing', () => {
    expect(headingFromAlpha(0, 0)).toBeCloseTo(0);
    expect(headingFromAlpha(90, 0)).toBeCloseTo(deg(270));
    expect(headingFromAlpha(270, 0)).toBeCloseTo(deg(90));
  });

  it('landscape (90°): device top pointing north means the screen top points east', () => {
    expect(headingFromAlpha(0, 90)).toBeCloseTo(deg(90));
  });

  it('landscape (90°): device top pointing west means the screen top points north', () => {
    expect(headingFromAlpha(90, 90)).toBeCloseTo(0);
  });

  it('landscape (270°) and upside-down portrait (180°)', () => {
    expect(headingFromAlpha(0, 270)).toBeCloseTo(deg(270));
    expect(headingFromAlpha(0, 180)).toBeCloseTo(deg(180));
  });

  it('stays within [0, 2π)', () => {
    for (const alpha of [0, 0.5, 90, 180, 359.9]) {
      for (const angle of [0, 90, 180, 270]) {
        const h = headingFromAlpha(alpha, angle);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(2 * Math.PI);
      }
    }
  });
});

describe('headingFromWebkitCompass', () => {
  it('portrait: uses the CW bearing as-is', () => {
    expect(headingFromWebkitCompass(45, 0)).toBeCloseTo(deg(45));
  });

  it('landscape: adds the screen rotation and wraps', () => {
    expect(headingFromWebkitCompass(0, 90)).toBeCloseTo(deg(90));
    expect(headingFromWebkitCompass(300, 90)).toBeCloseTo(deg(30));
  });
});
