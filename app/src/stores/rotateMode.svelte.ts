export type AutoRotateMode = 'north' | 'cog' | 'heading' | 'bearing';
export type RotateMode = AutoRotateMode | 'manual';
import { resolveResumeMode } from './rotateModeLogic';

const AUTO_MODES: AutoRotateMode[] = ['north', 'cog', 'heading', 'bearing'];
const ALL_MODES: RotateMode[] = [...AUTO_MODES, 'manual'];

const LABELS: Record<RotateMode, string> = {
  north: 'N',
  cog: 'COG',
  heading: 'HDG',
  bearing: 'BRG',
  manual: 'MAN',
};

const LS_KEY = 'rotate-mode';

function isAutoRotateMode(v: unknown): v is AutoRotateMode {
  return typeof v === 'string' && (AUTO_MODES as string[]).includes(v);
}

function isRotateMode(v: unknown): v is RotateMode {
  return typeof v === 'string' && (ALL_MODES as string[]).includes(v);
}

interface SavedRotateMode { mode: RotateMode; resumeMode: AutoRotateMode }

/** Reads the last-persisted rotation mode, falling back to north on first run / corrupt data. */
function loadSaved(): SavedRotateMode {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) {
      const p = JSON.parse(s) as { mode?: unknown; resumeMode?: unknown };
      if (isRotateMode(p.mode)) {
        return { mode: p.mode, resumeMode: isAutoRotateMode(p.resumeMode) ? p.resumeMode : 'north' };
      }
    }
  } catch { /* ignore */ }
  return { mode: 'north', resumeMode: 'north' };
}

function save(mode: RotateMode, resumeMode: AutoRotateMode): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ mode, resumeMode })); } catch { /* ignore */ }
}

function isAvailable(m: AutoRotateMode, hasCog: boolean, hasHeading: boolean, hasCourse: boolean): boolean {
  if (m === 'cog')     return hasCog;
  if (m === 'heading') return hasHeading;
  if (m === 'bearing') return hasCourse;
  return true;
}

function createRotateModeStore() {
  const saved = loadSaved();
  let mode = $state<RotateMode>(saved.mode);
  let resumeMode = $state<AutoRotateMode>(saved.resumeMode);

  return {
    get mode() { return mode; },
    get resumeMode() { return resumeMode; },
    get label()         { return LABELS[mode]; },
    /** Label shown in the compass SVG center — 'FREE' replaces 'MAN'. */
    get compassLabel()  { return mode === 'manual' ? 'FREE' : LABELS[mode]; },

    /**
     * Tap action on the compass button.
     * - Free mode → re-engage last remembered auto mode.
     * - Auto mode → advance to the next available auto mode (manual not in cycle).
     */
    toggle(hasCog: boolean, hasHeading: boolean, hasCourse: boolean) {
      if (mode === 'manual') {
        // Tap while free → snap back to last auto mode.
        mode = resumeMode;
        save(mode, resumeMode);
        return;
      }
      // Cycle through available auto modes only.
      const available = AUTO_MODES.filter(m => isAvailable(m, hasCog, hasHeading, hasCourse));
      if (available.length === 0) return;
      const idx = available.indexOf(mode);
      mode = available[(idx + 1) % available.length]!;
      save(mode, resumeMode);
    },

    /**
     * Long-press action on the compass button.
     * Toggles between free rotation (manual) and the last remembered auto mode.
     * Orthogonal to position pinning — does not affect followMode.
     */
    toggleLock(hasCog: boolean, hasHeading: boolean, hasCourse: boolean) {
      if (mode === 'manual') {
        mode = resolveResumeMode(resumeMode, hasCog, hasHeading, hasCourse);
      } else {
        resumeMode = mode;
        mode = 'manual';
      }
      save(mode, resumeMode);
    },

    /**
     * Called reactively when availability changes (e.g. route cleared, GPS lost).
     * If the current auto mode is no longer available, falls back to COG → north.
     * No-op in manual mode.
     */
    ensureAvailable(hasCog: boolean, hasHeading: boolean, hasCourse: boolean) {
      if (mode === 'manual') return;
      if (isAvailable(mode, hasCog, hasHeading, hasCourse)) return;
      const next: AutoRotateMode = hasCog ? 'cog' : 'north';
      if (next === mode) return;
      mode = next;
      save(mode, resumeMode);
    },
  };
}

export const rotateMode = createRotateModeStore();
