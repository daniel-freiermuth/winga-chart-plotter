export interface FollowOffset { left: number; top: number }

function createFollowStore() {
  let offset = $state<FollowOffset | null>(null);
  return {
    get offset()                       { return offset; },
    set offset(v: FollowOffset | null) { offset = v; },
    /** True when following; read by UI components that only need the boolean. */
    get following()                    { return offset !== null; },
  };
}

export const followMode = createFollowStore();
