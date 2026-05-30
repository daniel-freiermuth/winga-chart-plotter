const STORAGE_KEY = 'signalk-chart-settings';

export type LineStyle = 'solid' | 'dashed' | 'dotted' | 'dash-dot';

export interface LineAppearance {
  color: string;
  width: number;       // screen pixels
  style: LineStyle;
  lengthUnit: 'nm' | 'min' | 'px';
  lengthValue: number;
}

export interface AisAppearance {
  vesselColor: string;
  vesselSize: number;   // screen pixels
  cog: {
    color: string;
    width: number;
    style: LineStyle;
    lengthMinutes: number;
  };
}

export interface RulerAppearance {
  color: string;
  width: number;  // screen pixels
}

export interface RouteLineAppearance {
  color: string;
  width: number;  // screen pixels
  style: LineStyle;
}

export interface RouteAppearance {
  bearing:   RouteLineAppearance;  // vessel → next waypoint
  segment:   RouteLineAppearance;  // previous → next waypoint (active leg)
  remaining: RouteLineAppearance;  // full planned route polyline
}

export interface TrackAppearance {
  show:         boolean;
  color:        string;
  width:        number;    // screen pixels
  style:        LineStyle;
  historyHours: number;   // how far back to fetch (logarithmic slider, 5min–5yr)
}

export interface AppearanceSettings {
  vesselColor: string;
  vesselSize: number;  // screen pixels
  heading:     LineAppearance;
  cog:         LineAppearance;
  gc:          LineAppearance;
  ais:         AisAppearance;
  ruler:       RulerAppearance;
  route:       RouteAppearance;
  track:       TrackAppearance;
}

export interface SettingsData {
  signalkProtocol: 'ws' | 'wss';
  signalkHost: string;
  signalkPort: number;
  useGeoLocation: boolean;
  appearance: AppearanceSettings;
  targetFps: number;
}

const DEFAULTS: SettingsData = {
  ...detectSignalkOrigin(),
  useGeoLocation: false,
  targetFps: 60,
  appearance: {
    vesselColor: '#2563eb',
    vesselSize: 24,
    heading: { color: '#ffffff', width: 2, style: 'solid',  lengthUnit: 'nm',  lengthValue: 0.2 },
    cog:     { color: '#f59e0b', width: 2, style: 'dashed', lengthUnit: 'min', lengthValue: 3   },
    gc:      { color: '#22c55e', width: 2, style: 'dashed', lengthUnit: 'min', lengthValue: 3   },
    ais: {
      vesselColor: '#f59e0b',
      vesselSize: 16,
      cog: { color: '#f59e0b', width: 1.5, style: 'dashed', lengthMinutes: 3 },
    },
    ruler: { color: '#ffdc32', width: 2 },
    route: {
      bearing:   { color: '#ff6d00', width: 2,   style: 'dashed' },
      segment:   { color: '#e040fb', width: 2.5, style: 'solid'  },
      remaining: { color: '#e040fb', width: 2,   style: 'dashed' },
    },
    track: { show: true, color: '#3b82f6', width: 2, style: 'solid', historyHours: 24 },
  },
};

const SIGNALK_PATH     = '/signalk/v1/stream?subscribe=self';

// When the app is served by the Signal K server itself (installed as a webapp),
// the page origin IS the Signal K endpoint — no manual host configuration needed.
// Detect this by checking if we're running on port 3000 (Signal K default) or
// any non-Vite-dev-server port that isn't a typical static file server.
function detectSignalkOrigin(): Pick<SettingsData, 'signalkProtocol' | 'signalkHost' | 'signalkPort'> {
  const loc = window.location;
  const port = parseInt(loc.port || (loc.protocol === 'https:' ? '443' : '80'));
  return {
    signalkProtocol: loc.protocol === 'https:' ? 'wss' : 'ws',
    signalkHost: loc.hostname,
    signalkPort: port,
  };
}

function load(): SettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as Partial<SettingsData>;
        return {
          ...DEFAULTS, ...p,
          useGeoLocation: typeof p.useGeoLocation === 'boolean' ? p.useGeoLocation : DEFAULTS.useGeoLocation,
          targetFps: typeof p.targetFps === 'number' && p.targetFps > 0 ? p.targetFps : DEFAULTS.targetFps,
          appearance: {
            ...DEFAULTS.appearance, ...(p.appearance ?? {}),
            heading: { ...DEFAULTS.appearance.heading, ...(p.appearance?.heading ?? {}) },
            cog:     { ...DEFAULTS.appearance.cog,     ...(p.appearance?.cog     ?? {}) },
            gc:      { ...DEFAULTS.appearance.gc,      ...(p.appearance?.gc      ?? {}) },
            ais: {
              ...DEFAULTS.appearance.ais,
              ...(p.appearance?.ais ?? {}),
              cog: { ...DEFAULTS.appearance.ais.cog, ...(p.appearance?.ais?.cog ?? {}) },
            },
            ruler: { ...DEFAULTS.appearance.ruler, ...(p.appearance?.ruler ?? {}) },
            route: {
              bearing:   { ...DEFAULTS.appearance.route.bearing,   ...(p.appearance?.route?.bearing   ?? {}) },
              segment:   { ...DEFAULTS.appearance.route.segment,   ...(p.appearance?.route?.segment   ?? {}) },
              remaining: { ...DEFAULTS.appearance.route.remaining, ...(p.appearance?.route?.remaining ?? {}) },
            },
            track: { ...DEFAULTS.appearance.track, ...(p.appearance?.track ?? {}) },
          },
        };
      }
    }
  } catch { /* ignore corrupt storage */ }
  return structuredClone(DEFAULTS);
}

function createSettings() {
  const data = $state<SettingsData>(load());
  let geoError = $state<string | null>(null);

  return {
    get protocol(): 'ws' | 'wss' { return data.signalkProtocol; },
    get host(): string            { return data.signalkHost; },
    get port(): number            { return data.signalkPort; },
    get useGeoLocation(): boolean { return data.useGeoLocation; },
    get geoError(): string | null { return geoError; },
    get appearance(): AppearanceSettings { return data.appearance; },
    get targetFps(): number       { return data.targetFps; },
    get signalkUrl(): string {
      return `${data.signalkProtocol}://${data.signalkHost}:${String(data.signalkPort)}${SIGNALK_PATH}`;
    },
    get signalkHttpUrl(): string {
      const proto = data.signalkProtocol === 'wss' ? 'https' : 'http';
      return `${proto}://${data.signalkHost}:${String(data.signalkPort)}`;
    },
    apply(next: Partial<SettingsData>) {
      if (next.signalkProtocol !== undefined) data.signalkProtocol = next.signalkProtocol;
      if (next.signalkHost     !== undefined) data.signalkHost     = next.signalkHost;
      if (next.signalkPort     !== undefined) data.signalkPort     = next.signalkPort;
      if (next.useGeoLocation  !== undefined) {
        data.useGeoLocation = next.useGeoLocation;
        if (next.useGeoLocation) geoError = null; // clear error when user re-enables
      }
      if (next.appearance      !== undefined) data.appearance      = next.appearance;
      if (next.targetFps       !== undefined) data.targetFps       = next.targetFps;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },
    setGeoError(msg: string) {
      geoError = msg;
    },
    setTargetFps(fps: number) {
      data.targetFps = fps;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },
  };
}

export const settings = createSettings();
