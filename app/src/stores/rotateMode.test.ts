import { describe, expect, it } from 'vitest';
import { resolveResumeMode } from './rotateModeLogic';

/**
 * Regression: toggle() must not restore an unavailable resumeMode.
 *
 * If the sensor backing resumeMode was lost while the user was in manual
 * mode (e.g. heading sensor disconnected while resumeMode='heading'),
 * restoring 'heading' unconditionally puts the compass in a mode with no
 * data.  resolveResumeMode() validates availability before restoring,
 * falling back to the first available auto mode or 'north'.
 */
describe('resolveResumeMode', () => {
  it('returns resumeMode when it is available', () => {
    expect(resolveResumeMode('heading', true, true, false)).toBe('heading');
    expect(resolveResumeMode('cog', true, false, false)).toBe('cog');
    expect(resolveResumeMode('bearing', true, true, true)).toBe('bearing');
    expect(resolveResumeMode('north', false, false, false)).toBe('north');
  });

  it('does not return unavailable resumeMode', () => {
    // heading unavailable → must not return 'heading'
    const result = resolveResumeMode('heading', true, false, false);
    expect(result).not.toBe('heading');
    // 'north' is first in AUTO_MODES and always available
    expect(result).toBe('north');
  });

  it('falls back to north when no sensors available', () => {
    expect(resolveResumeMode('heading', false, false, false)).toBe('north');
    expect(resolveResumeMode('cog', false, false, false)).toBe('north');
    expect(resolveResumeMode('bearing', false, false, false)).toBe('north');
  });

  it('falls back to north when preferred mode unavailable', () => {
    expect(resolveResumeMode('heading', true, false, false)).toBe('north');
    expect(resolveResumeMode('bearing', true, false, false)).toBe('north');
  });

  it('north is always available', () => {
    expect(resolveResumeMode('north', false, false, false)).toBe('north');
    expect(resolveResumeMode('north', true, true, true)).toBe('north');
  });
});
