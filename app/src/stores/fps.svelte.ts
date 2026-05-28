/** Reactive store for measured (actual) frame rate, updated each rAF tick. */
function createFpsStore() {
  let value = $state(0);
  return {
    get value() { return value; },
    set(v: number) { value = v; },
  };
}

export const fpsStore = createFpsStore();
