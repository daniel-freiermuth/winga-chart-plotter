/** Pure logic for rotate-mode availability — no Svelte runes, testable in Node. */

export type AutoRotateMode = 'north' | 'cog' | 'heading' | 'bearing';
export type RotateMode = AutoRotateMode | 'manual';

export const AUTO_MODES: AutoRotateMode[] = ['north', 'cog', 'heading', 'bearing'];

export function isAvailable(m: AutoRotateMode, hasCog: boolean, hasHeading: boolean, hasCourse: boolean): boolean {
  if (m === 'cog')     return hasCog;
  if (m === 'heading') return hasHeading;
  if (m === 'bearing') return hasCourse;
  return true;
}

/**
 * Resolve the mode to restore when leaving manual/free rotation.
 *
 * Returns `preferred` if its backing sensor is still available,
 * otherwise the first available auto mode, falling back to 'north'.
 */
export function resolveResumeMode(
  preferred: AutoRotateMode,
  hasCog: boolean,
  hasHeading: boolean,
  hasCourse: boolean,
): AutoRotateMode {
  if (isAvailable(preferred, hasCog, hasHeading, hasCourse)) return preferred;
  return AUTO_MODES.find(m => isAvailable(m, hasCog, hasHeading, hasCourse)) ?? 'north';
}
