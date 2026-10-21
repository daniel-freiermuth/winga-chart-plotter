import { describe, expect, it } from 'vitest';
import { formatDm } from './coordFormat';

describe('formatDm', () => {
  // The result is also the default waypoint name persisted to the Signal K
  // server, so it must be plain text that other clients display verbatim.
  it('returns plain text without HTML entities', () => {
    const s = formatDm(59.91, 10.75);
    expect(s).not.toMatch(/&[a-z#0-9]+;/i);
    expect(s).toBe("59°\u202f54.600'\u202fN\u200310°\u202f45.000'\u202fE");
  });
});
