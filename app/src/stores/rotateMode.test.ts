import { describe, expect, it } from 'vitest';
import { resolveResumeMode } from './rotateModeLogic';

/**
 * Regression: toggleLock() must not restore an unavailable resumeMode.
 *
 * When leaving manual mode via long-press, if the sensor backing
 * resumeMode was lost (e.g. route cleared while resumeMode='bearing'),
 * restoring 'bearing' puts the compass in a mode with no data.
 * resolveResumeMode() validates availability before restoring.
 */
describe('resolveResumeMode (toggleLock regression)', () => {
  it('does not return bearing when route is unavailable', () => {
    // resumeMode='bearing' but hasCourse=false → must not return 'bearing'
    const result = resolveResumeMode('bearing', true, false, false);
    expect(result).not.toBe('bearing');
    expect(result).toBe('north');
  });

  it('does not return heading when heading sensor lost', () => {
    const result = resolveResumeMode('heading', true, false, false);
    expect(result).not.toBe('heading');
    expect(result).toBe('north');
  });

  it('does not return cog when GPS lost', () => {
    const result = resolveResumeMode('cog', false, false, false);
    expect(result).not.toBe('cog');
    expect(result).toBe('north');
  });

  it('returns resumeMode when it is available', () => {
    expect(resolveResumeMode('bearing', true, true, true)).toBe('bearing');
    expect(resolveResumeMode('heading', true, true, false)).toBe('heading');
    expect(resolveResumeMode('cog', true, false, false)).toBe('cog');
    expect(resolveResumeMode('north', false, false, false)).toBe('north');
  });

  it('north is always available', () => {
    expect(resolveResumeMode('north', false, false, false)).toBe('north');
  });
});
