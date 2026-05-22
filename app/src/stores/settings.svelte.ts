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
  };
}

export interface AppearanceSettings {
  vesselColor: string;
  vesselSize: number;  // screen pixels
  heading:     LineAppearance;
  cog:         LineAppearance;
  gc:          LineAppearance;
  ais:         AisAppearance;
}

export interface SettingsData {
  signalkProtocol: 'ws' | 'wss';
  signalkHost: string;
  signalkPort: number;
  appearance: AppearanceSettings;
}

const DEFAULTS: SettingsData = {
  signalkProtocol: 'ws',
  signalkHost: 'localhost',
  signalkPort: 3000,
  appearance: {
    vesselColor: '#2563eb',
    vesselSize: 24,
    heading: { color: '#ffffff', width: 2, style: 'solid',  lengthUnit: 'nm',  lengthValue: 0.2 },
    cog:     { color: '#f59e0b', width: 2, style: 'dashed', lengthUnit: 'min', lengthValue: 3   },
    gc:      { color: '#22c55e', width: 2, style: 'dashed', lengthUnit: 'min', lengthValue: 3   },
    ais: {
      vesselColor: '#f59e0b',
      vesselSize: 16,
      cog: { color: '#f59e0b', width: 1.5, style: 'dashed' },
    },
  },
};

const SIGNALK_PATH     = '/signalk/v1/stream?subscribe=self';

function load(): SettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as Partial<SettingsData>;
        return {
          ...DEFAULTS, ...p,
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
          },
        };
      }
    }
  } catch { /* ignore corrupt storage */ }
  return structuredClone(DEFAULTS);
}

function createSettings() {
  const data = $state<SettingsData>(load());

  return {
    get protocol(): 'ws' | 'wss' { return data.signalkProtocol; },
    get host(): string            { return data.signalkHost; },
    get port(): number            { return data.signalkPort; },
    get appearance(): AppearanceSettings { return data.appearance; },
    get signalkUrl(): string {
      return `${data.signalkProtocol}://${data.signalkHost}:${String(data.signalkPort)}${SIGNALK_PATH}`;
    },
    get signalkHttpUrl(): string {
      const proto = data.signalkProtocol === 'wss' ? 'https' : 'http';
      return `${proto}://${data.signalkHost}:${String(data.signalkPort)}`;
    },
    apply(next: SettingsData) {
      data.signalkProtocol = next.signalkProtocol;
      data.signalkHost     = next.signalkHost;
      data.signalkPort     = next.signalkPort;
      data.appearance      = next.appearance;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },
  };
}

export const settings = createSettings();
