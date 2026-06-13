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
        resumeMode = mode;
        mode = 'manual';
      }
    },

    /**
     * Called when the button is clicked.
     * - If in manual: return to the saved auto mode.
     * - If in auto: advance to the next available auto mode.
     */
    toggle(hasCog: boolean, hasHeading: boolean, hasCourse: boolean) {
      // Cycle: [available auto modes..., manual] → wraps back to start.
      const available: RotateMode[] = [
        ...AUTO_MODES.filter(m => isAvailable(m, hasCog, hasHeading, hasCourse)),
        'manual',
      ];
      const idx = available.indexOf(mode);
      const next = available[(idx + 1) % available.length]!;
      // Save auto mode when entering manual so ensureAvailable has a valid fallback.
      if (next === 'manual') resumeMode = mode as AutoRotateMode;
      mode = next;
    },

    /**
     * Called reactively when availability changes (e.g. route cleared, GPS lost).
     * If the current auto mode is no longer available, falls back to COG → north.
     * No-op in manual mode.
     */
    ensureAvailable(hasCog: boolean, hasHeading: boolean, hasCourse: boolean) {
      if (mode === 'manual') return;
      if (isAvailable(mode, hasCog, hasHeading, hasCourse)) return;
      if (hasCog) { mode = 'cog'; return; }
      mode = 'north';
    },
  };
}

export const rotateMode = createRotateModeStore();
