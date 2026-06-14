const STORAGE_KEY = 'signalk-chart-settings';

export type LineStyle = 'solid' | 'dashed' | 'dotted' | 'dash-dot';

export type SettingsTab = 'connection' | 'vessel' | 'ais' | 'routes' | 'about';

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
  track: {
    show:         boolean;
    color:        string;
    width:        number;
    style:        LineStyle;
    historyHours: number;   // how far back to fetch for AIS vessel tracks
  };
}

export interface RulerAppearance {
  color: string;
  width: number;  // screen pixels
}

export interface PlannerAppearance {
  color: string;
  width: number;  // screen pixels (route line)
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
  allRoutes: RouteLineAppearance;  // all server routes (non-active)
}

export interface TrackAppearance {
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
  planner:     PlannerAppearance;
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
  resourcePollIntervalSeconds: number;
}

const DEFAULTS: SettingsData = {
  ...detectSignalkOrigin(),
  useGeoLocation: false,
  targetFps: 60,
  resourcePollIntervalSeconds: 5,
  appearance: {
    vesselColor: '#ef4444',
    vesselSize: 30,
    heading: { color: '#f97316', width: 2, style: 'solid',  lengthUnit: 'px',  lengthValue: 50  },
    cog:     { color: '#f97316', width: 2, style: 'dashed', lengthUnit: 'px',  lengthValue: 0   },
    gc:      { color: '#ef4444', width: 2, style: 'solid',  lengthUnit: 'min', lengthValue: 30  },
    ais: {
      vesselColor: '#22c55e',
      vesselSize: 20,
      cog:   { color: '#374151', width: 1.5, style: 'dashed', lengthMinutes: 3 },
      track: { show: true, color: '#f97316', width: 2, style: 'solid', historyHours: 24 },
    },
    ruler: { color: '#1e3a8a', width: 2 },
    planner: { color: '#64c8ff', width: 6 },
    route: {
      bearing:   { color: '#ff6d00', width: 4,   style: 'dashed' },
      segment:   { color: '#e040fb', width: 4, style: 'solid'  },
      remaining: { color: '#e040fb', width: 4,   style: 'dashed' },
      allRoutes: { color: '#7cc8e8', width: 3, style: 'dashed' },
    },
    track: { color: '#3b82f6', width: 2, style: 'solid', historyHours: 24 },
  },
};

const SIGNALK_PATH     = '/signalk/v1/stream?subscribe=self';

function isHttpsContext(): boolean {
  return window.location.protocol === 'https:';
}

function normalizedProtocol(protocol: 'ws' | 'wss'): 'ws' | 'wss' {
  // Browsers block insecure WebSocket from HTTPS pages, so upgrade automatically.
  return isHttpsContext() ? 'wss' : protocol;
}

function normalizeConnection(input: Pick<SettingsData, 'signalkProtocol' | 'signalkHost' | 'signalkPort'>): Pick<SettingsData, 'signalkProtocol' | 'signalkHost' | 'signalkPort'> {
  let host = input.signalkHost.trim();
  let protocol = input.signalkProtocol;
  let port = input.signalkPort;

  // Accept pasted host values like "https://host:443" and split them safely.
  if (host.includes('://')) {
    try {
      const parsed = new URL(host);
      host = parsed.hostname;
      if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') protocol = 'wss';
      if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') protocol = 'ws';
      if (parsed.port) {
        const parsedPort = Number.parseInt(parsed.port, 10);
        if (Number.isFinite(parsedPort)) port = parsedPort;
      }
    } catch {
      // Keep host as-is if it is not a valid URL.
    }
  }

  const coercedProtocol = normalizedProtocol(protocol);
  const safePort = Number.isFinite(port) && port > 0 ? port : (coercedProtocol === 'wss' ? 443 : 80);

  return {
    signalkProtocol: coercedProtocol,
    signalkHost: host,
    signalkPort: safePort,
  };
}

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
        const normalizedConn = normalizeConnection({
          signalkProtocol: p.signalkProtocol ?? DEFAULTS.signalkProtocol,
          signalkHost: p.signalkHost ?? DEFAULTS.signalkHost,
          signalkPort: p.signalkPort ?? DEFAULTS.signalkPort,
        });
        return {
          ...DEFAULTS, ...p,
          ...normalizedConn,
          useGeoLocation: typeof p.useGeoLocation === 'boolean' ? p.useGeoLocation : DEFAULTS.useGeoLocation,
          targetFps: typeof p.targetFps === 'number' && p.targetFps > 0 ? p.targetFps : DEFAULTS.targetFps,
          resourcePollIntervalSeconds: typeof p.resourcePollIntervalSeconds === 'number' && p.resourcePollIntervalSeconds > 0 ? p.resourcePollIntervalSeconds : DEFAULTS.resourcePollIntervalSeconds,
          appearance: {
            ...DEFAULTS.appearance, ...(p.appearance ?? {}),
            heading: { ...DEFAULTS.appearance.heading, ...(p.appearance?.heading ?? {}) },
            cog:     { ...DEFAULTS.appearance.cog,     ...(p.appearance?.cog     ?? {}) },
            gc:      { ...DEFAULTS.appearance.gc,      ...(p.appearance?.gc      ?? {}) },
            ais: {
              ...DEFAULTS.appearance.ais,
              ...(p.appearance?.ais ?? {}),
              cog:   { ...DEFAULTS.appearance.ais.cog,   ...(p.appearance?.ais.cog   ?? {}) },
              track: { ...DEFAULTS.appearance.ais.track, ...(p.appearance?.ais.track ?? {}) },
            },
            ruler: { ...DEFAULTS.appearance.ruler, ...(p.appearance?.ruler ?? {}) },
            planner: { ...DEFAULTS.appearance.planner, ...(p.appearance?.planner ?? {}) },
            route: {
              bearing:   { ...DEFAULTS.appearance.route.bearing,   ...(p.appearance?.route.bearing   ?? {}) },
              segment:   { ...DEFAULTS.appearance.route.segment,   ...(p.appearance?.route.segment   ?? {}) },
              remaining: { ...DEFAULTS.appearance.route.remaining, ...(p.appearance?.route.remaining ?? {}) },
              allRoutes: { ...DEFAULTS.appearance.route.allRoutes, ...(p.appearance?.route.allRoutes ?? {}) },
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
  let geoError    = $state<string | null>(null);
  let geoAccuracy = $state<number | null>(null); // metres, null = no fix yet

  return {
    get protocol(): 'ws' | 'wss' { return data.signalkProtocol; },
    get host(): string            { return data.signalkHost; },
    get port(): number            { return data.signalkPort; },
    get useGeoLocation(): boolean { return data.useGeoLocation; },
    get geoError(): string | null { return geoError; },
    /** Current position accuracy in metres. null = no fix yet. */
    get geoAccuracy(): number | null { return geoAccuracy; },
    get appearance(): AppearanceSettings { return data.appearance; },
    get targetFps(): number       { return data.targetFps; },
    get resourcePollIntervalSeconds(): number { return data.resourcePollIntervalSeconds; },
    get signalkUrl(): string {
      const protocol = normalizedProtocol(data.signalkProtocol);
      return `${protocol}://${data.signalkHost}:${String(data.signalkPort)}${SIGNALK_PATH}`;
    },
    get signalkHttpUrl(): string {
      const proto = normalizedProtocol(data.signalkProtocol) === 'wss' ? 'https' : 'http';
      return `${proto}://${data.signalkHost}:${String(data.signalkPort)}`;
    },
    apply(next: Partial<SettingsData>) {
      const conn = normalizeConnection({
        signalkProtocol: next.signalkProtocol ?? data.signalkProtocol,
        signalkHost: next.signalkHost ?? data.signalkHost,
        signalkPort: next.signalkPort ?? data.signalkPort,
      });
      data.signalkProtocol = conn.signalkProtocol;
      data.signalkHost = conn.signalkHost;
      data.signalkPort = conn.signalkPort;
      if (next.useGeoLocation  !== undefined) {
        data.useGeoLocation = next.useGeoLocation;
        if (next.useGeoLocation) { geoError = null; geoAccuracy = null; }
      }
      if (next.appearance      !== undefined) data.appearance      = next.appearance;
      if (next.targetFps       !== undefined) data.targetFps       = next.targetFps;
      if (next.resourcePollIntervalSeconds !== undefined) data.resourcePollIntervalSeconds = next.resourcePollIntervalSeconds;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },
    setGeoError(msg: string | null) {
      geoError = msg;
    },
    setGeoAccuracy(metres: number | null) {
      geoAccuracy = metres;
    },
    setTargetFps(fps: number) {
      data.targetFps = fps;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },
    /** Persist the current state without any reactive re-assignments. Use from appearance
     *  controls that mutate data.appearance directly via $state proxy (bind:value, oninput)
     *  and only need to flush to localStorage. Calling settings.apply() instead would cause
     *  spurious track.init() re-runs because it reassigns data.appearance. */
    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },
  };
}

export const settings = createSettings();
