export type AutoRotateMode = 'north' | 'cog' | 'heading' | 'course';
export type RotateMode = AutoRotateMode | 'manual';

const AUTO_MODES: AutoRotateMode[] = ['north', 'cog', 'heading', 'course'];

const LABELS: Record<RotateMode, string> = {
  north: 'N',
  cog: 'COG',
  heading: 'HDG',
  course: 'BRG',
  manual: 'MAN',
};

function createRotateModeStore() {
  let mode = $state<RotateMode>('north');
  let resumeMode = $state<AutoRotateMode>('north');

  function isAvailable(m: AutoRotateMode, hasHeading: boolean, hasCourse: boolean): boolean {
    if (m === 'heading') return hasHeading;
    if (m === 'course') return hasCourse;
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
    toggle(hasHeading: boolean, hasCourse: boolean) {
      if (mode === 'manual') {
        mode = resumeMode;
        return;
      }
      const current = mode as AutoRotateMode;
      const idx = AUTO_MODES.indexOf(current);
      for (let i = 1; i <= AUTO_MODES.length; i++) {
        const next = AUTO_MODES[(idx + i) % AUTO_MODES.length];
        if (isAvailable(next, hasHeading, hasCourse)) {
          mode = next;
          return;
        }
      }
    },
  };
}

export const rotateMode = createRotateModeStore();
