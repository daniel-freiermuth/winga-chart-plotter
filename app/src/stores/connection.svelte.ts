/** Reactive store for Signal K WebSocket connection status. */
function createConnectionStore() {
  let connected = $state(false);
  let error = $state<string | null>(null);
  // Bumped on every transition into "connected". Consumers that must act once
  // per (re)connect — rather than on every read of `connected` — key off this:
  // a boolean that is already true carries no edge to react to.
  let epoch = $state(0);
  return {
    get connected() { return connected; },
    get error() { return error; },
    get epoch() { return epoch; },
    setConnected(v: boolean) {
      if (v && !connected) epoch++;
      connected = v;
    },
    setError(v: string | null) { error = v; },
  };
}

export const connection = createConnectionStore();
