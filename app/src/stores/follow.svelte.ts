export interface FollowOffset { left: number; top: number }

const LS_KEY = 'follow-mode-offset';

/** Per-pane vessel-follow (pinning) state. */
export interface FollowStore {
  /** Viewport-fraction offset the vessel is pinned at; null = not following. */
  offset: FollowOffset | null;
  /** True when following; read by UI components that only need the boolean. */
  readonly following: boolean;
}

/** Reads the last-persisted follow offset, falling back to "not following" on first run / corrupt data. */
function loadSaved(key: string): FollowOffset | null {
  try {
    const s = localStorage.getItem(key);
    if (s) {
      const p = JSON.parse(s) as Partial<FollowOffset>;
      if (typeof p.left === 'number' && typeof p.top === 'number') return { left: p.left, top: p.top };
    }
  } catch { /* ignore */ }
  return null;
}

/** `lsSuffix` namespaces the localStorage key per pane ('' = primary pane, legacy key). */
export function createFollowStore(lsSuffix = ''): FollowStore {
  const key = LS_KEY + lsSuffix;
  let offset = $state<FollowOffset | null>(loadSaved(key));
  return {
    get offset()                       { return offset; },
    set offset(v: FollowOffset | null) {
      offset = v;
      try {
        if (v) localStorage.setItem(key, JSON.stringify(v));
        else   localStorage.removeItem(key);
      } catch { /* ignore */ }
    },
    get following()                    { return offset !== null; },
  };
}
