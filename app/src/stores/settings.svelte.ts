const STORAGE_KEY = 'signalk-chart-settings';

const DEFAULTS = {
  signalkProtocol: 'ws' as 'ws' | 'wss',
  signalkHost: 'localhost',
  signalkPort: 3000,
};

type Settings = typeof DEFAULTS;

const SIGNALK_PATH = '/signalk/v1/stream?subscribe=self';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULTS };
}

function saveSettings(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function createSettings() {
  let data = $state(loadSettings());

  return {
    get protocol() { return data.signalkProtocol; },
    set protocol(v: 'ws' | 'wss') { data.signalkProtocol = v; saveSettings(data); },

    get host() { return data.signalkHost; },
    set host(v: string) { data.signalkHost = v; saveSettings(data); },

    get port() { return data.signalkPort; },
    set port(v: number) { data.signalkPort = v; saveSettings(data); },

    get signalkUrl() {
      return `${data.signalkProtocol}://${data.signalkHost}:${data.signalkPort}${SIGNALK_PATH}`;
    },
  };
}

export const settings = createSettings();
