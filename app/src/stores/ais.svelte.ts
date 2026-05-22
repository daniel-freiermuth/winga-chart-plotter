export interface AisTarget {
  id: string;
  mmsi?: string;
  name?: string;
  position?: { longitude: number; latitude: number; altitude?: number };
  cog?: number;
  sog?: number;
  heading?: number;
}

function createAisStore() {
  let targets = $state<AisTarget[]>([]);
  let nameCache = new Map<string, string>();

  return {
    get targets(): AisTarget[] { return targets; },

    setNameCache(map: Map<string, string>) {
      nameCache = map;
      if (targets.length > 0) {
        targets = targets.map(t => {
          const name = t.name ?? nameCache.get(t.id);
          return name !== undefined ? { ...t, name } : t;
        });
      }
    },

    update(incoming: AisTarget[]) {
      targets = incoming.map(t => {
        const name = t.name ?? nameCache.get(t.id);
        return name !== undefined ? { ...t, name } : t;
      });
    },
  };
}

export const ais = createAisStore();
