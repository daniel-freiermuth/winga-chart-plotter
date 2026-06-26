export interface FollowOffset { left: number; top: number }

const LS_KEY = 'follow-mode-offset';

/** Reads the last-persisted follow offset, falling back to "not following" on first run / corrupt data. */
function loadSaved(): FollowOffset | null {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) {
      const p = JSON.parse(s) as Partial<FollowOffset>;
      if (typeof p.left === 'number' && typeof p.top === 'number') return { left: p.left, top: p.top };
    }
  } catch { /* ignore */ }
  return null;
}

function createFollowStore() {
  let offset = $state<FollowOffset | null>(loadSaved());
  return {
    get offset()                       { return offset; },
    set offset(v: FollowOffset | null) {
      offset = v;
      try {
        if (v) localStorage.setItem(LS_KEY, JSON.stringify(v));
        else    localStorage.removeItem(LS_KEY);
      } catch { /* ignore */ }
    },
    /** True when following; read by UI components that only need the boolean. */
    get following()                    { return offset !== null; },
  };
}

export const followMode = createFollowStore();
