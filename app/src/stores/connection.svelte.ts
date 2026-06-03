/** Reactive store for Signal K WebSocket connection status. */
function createConnectionStore() {
  let connected = $state(false);
  let error = $state<string | null>(null);
  return {
    get connected() { return connected; },
    get error() { return error; },
    setConnected(v: boolean) { connected = v; },
    setError(v: string | null) { error = v; },
  };
}

export const connection = createConnectionStore();
