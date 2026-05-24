function createFollowStore() {
  let following = $state(false);
  return {
    get following() { return following; },
    set following(v: boolean) { following = v; },
  };
}

export const followMode = createFollowStore();
