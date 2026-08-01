import { loadJSON, saveJSON } from './paneStorage';

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

function load(key: string): VisibilityState {
  return { ...DEFAULTS, ...((loadJSON(key) ?? {}) as Partial<VisibilityState>) };
}

/** Per-pane layer visibility toggles. */
export interface VisibilityStore extends Readonly<VisibilityState> {
  toggle(key: keyof VisibilityState): void;
}

/** `lsSuffix` namespaces the localStorage key per pane ('' = primary pane, legacy key). */
export function createVisibilityStore(lsSuffix = ''): VisibilityStore {
  const lsKey = LS_KEY + lsSuffix;
  const saved = load(lsKey);
  let aisVessels    = $state(saved.aisVessels);
  let aisTracks     = $state(saved.aisTracks);
  let aisPredictors = $state(saved.aisPredictors);
  let ownTrack      = $state(saved.ownTrack);
  let routes        = $state(saved.routes);
  let waypoints     = $state(saved.waypoints);

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
      saveJSON(lsKey, { aisVessels, aisTracks, aisPredictors, ownTrack, routes, waypoints });
    },
  };
}
