/** In-memory `Storage` stub for tests (stubGlobal('localStorage', memStorage())). */
export function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem:    (k: string) => m.get(k) ?? null,
    setItem:    (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear:      () => { m.clear(); },
    key:        (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}
