const LS_KEY = 'layer-visibility';

export interface VisibilityState {
  aisVessels:    boolean;
  aisTracks:     boolean;
  aisPredictors: boolean;
  ownTrack:      boolean;
  routes:        boolean;
  waypoints:     boolean;
}

const DEFAULTS: VisibilityState = {
  aisVessels:    true,
  aisTracks:     false,
  aisPredictors: true,
  ownTrack:      true,
  routes:        true,
  waypoints:     true,
};

function load(): VisibilityState {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) return { ...DEFAULTS, ...(JSON.parse(s) as Partial<VisibilityState>) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

function createVisibilityStore() {
  const saved = load();
  let aisVessels    = $state(saved.aisVessels);
  let aisTracks     = $state(saved.aisTracks);
  let aisPredictors = $state(saved.aisPredictors);
  let ownTrack      = $state(saved.ownTrack);
  let routes        = $state(saved.routes);
  let waypoints     = $state(saved.waypoints);

  function persist() {
    localStorage.setItem(LS_KEY, JSON.stringify(
      { aisVessels, aisTracks, aisPredictors, ownTrack, routes, waypoints },
    ));
  }

  return {
    get aisVessels()    { return aisVessels;    },
    get aisTracks()     { return aisTracks;     },
    get aisPredictors() { return aisPredictors; },
    get ownTrack()      { return ownTrack;      },
    get routes()        { return routes;        },
    get waypoints()     { return waypoints;     },

    toggle(key: keyof VisibilityState) {
      if      (key === 'aisVessels')    { aisVessels    = !aisVessels;    }
      else if (key === 'aisTracks')     { aisTracks     = !aisTracks;     }
      else if (key === 'aisPredictors') { aisPredictors = !aisPredictors; }
      else if (key === 'ownTrack')      { ownTrack      = !ownTrack;      }
      else if (key === 'routes')        { routes        = !routes;        }
      else                              { waypoints     = !waypoints;     }
      persist();
    },
  };
}

export const visibility = createVisibilityStore();
