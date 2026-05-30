export type AutoRotateMode = 'north' | 'cog' | 'heading' | 'bearing';
export type RotateMode = AutoRotateMode | 'manual';

const AUTO_MODES: AutoRotateMode[] = ['north', 'cog', 'heading', 'bearing'];

const LABELS: Record<RotateMode, string> = {
  north: 'N',
  cog: 'COG',
  heading: 'HDG',
  bearing: 'BRG',
  manual: 'MAN',
};

function createRotateModeStore() {
  let mode = $state<RotateMode>('north');
  let resumeMode = $state<AutoRotateMode>('north');

  function isAvailable(m: AutoRotateMode, hasCog: boolean, hasHeading: boolean, hasCourse: boolean): boolean {
    if (m === 'cog')     return hasCog;
    if (m === 'heading') return hasHeading;
    if (m === 'bearing') return hasCourse;
    return true;
  }

  return {
    get mode() { return mode; },
    get resumeMode() { return resumeMode; },
    get label() { return LABELS[mode]; },

    /** Called when the user manually rotates the map (gesture detected). */
    setManual() {
      if (mode !== 'manual') {
        resumeMode = mode as AutoRotateMode;
        mode = 'manual';
      }
    },

    /**
     * Called when the button is clicked.
     * - If in manual: return to the saved auto mode.
     * - If in auto: advance to the next available auto mode.
     */
    toggle(hasCog: boolean, hasHeading: boolean, hasCourse: boolean) {
      if (mode === 'manual') {
        mode = resumeMode;
        return;
      }
      const current = mode as AutoRotateMode;
      const idx = AUTO_MODES.indexOf(current);
      for (let i = 1; i <= AUTO_MODES.length; i++) {
        const next = AUTO_MODES[(idx + i) % AUTO_MODES.length];
        if (isAvailable(next, hasCog, hasHeading, hasCourse)) {
          mode = next;
          return;
        }
      }
    },

    /**
     * Called reactively when availability changes (e.g. route cleared, GPS lost).
     * If the current auto mode is no longer available, falls back to COG → north.
     * No-op in manual mode.
     */
    ensureAvailable(hasCog: boolean, hasHeading: boolean, hasCourse: boolean) {
      if (mode === 'manual') return;
      if (isAvailable(mode as AutoRotateMode, hasCog, hasHeading, hasCourse)) return;
      if (hasCog) { mode = 'cog'; return; }
      mode = 'north';
    },
  };
}

export const rotateMode = createRotateModeStore();
