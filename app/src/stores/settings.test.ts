import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memStorage } from './testStorage';

const STORAGE_KEY = 'signalk-chart-settings';

/**
 * Tests for the settings store (settings.svelte.ts).
 *
 * The singleton is created at module load — `load()` runs once — so each test
 * resets the module registry and dynamically imports a fresh instance backed by
 * its own in-memory localStorage.
 */

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', memStorage());
  // settings.svelte.ts reads window.location at module init
  // (detectSignalkOrigin, isHttpsContext). URL is shape-compatible.
  vi.stubGlobal('window', { location: new URL('http://localhost:5173/') });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importSettings() {
  const mod = await import('./settings.svelte');
  return mod.settings;
}

async function importConstants() {
  return import('./settings.svelte');
}

// ---------------------------------------------------------------------------
// load() — corrupt / non-object storage
// ---------------------------------------------------------------------------

describe('load() — corrupt and non-object storage', () => {
  it('returns defaults for corrupt JSON', async () => {
    localStorage.setItem(STORAGE_KEY, '{not-valid-json!!!');
    const s = await importSettings();
    expect(s.targetFps).toBe(60);
    expect(s.splitRatio).toBe(0.5);
    expect(s.paneLayout).toBe('solo0');
  });

  it('returns defaults for array-shaped JSON', async () => {
    localStorage.setItem(STORAGE_KEY, '[1, 2, 3]');
    const s = await importSettings();
    // typeof [1,2,3] === 'object' but the guard also checks it against
    // Partial<SettingsData> — arrays don't satisfy the named-field merge,
    // but currently typeof [] === 'object' && [] !== null passes the guard.
    // Document the actual behavior: the spread `...DEFAULTS, ...p` treats
    // array indices as numeric keys, but the explicit field overrides still
    // fall through to defaults for the asserted fields.
    expect(s.targetFps).toBe(60);
    expect(s.splitRatio).toBe(0.5);
  });

  it('returns defaults for scalar JSON (number)', async () => {
    localStorage.setItem(STORAGE_KEY, '42');
    const s = await importSettings();
    // typeof 42 !== 'object' → guard fails → defaults
    expect(s.targetFps).toBe(60);
  });

  it('returns defaults for scalar JSON (string)', async () => {
    localStorage.setItem(STORAGE_KEY, '"hello"');
    const s = await importSettings();
    expect(s.targetFps).toBe(60);
  });

  it('returns defaults for JSON null', async () => {
    localStorage.setItem(STORAGE_KEY, 'null');
    const s = await importSettings();
    // typeof null === 'object' BUT the guard checks parsed !== null
    expect(s.targetFps).toBe(60);
  });

  it('returns defaults when nothing is stored', async () => {
    const s = await importSettings();
    expect(s.targetFps).toBe(60);
    expect(s.splitRatio).toBe(0.5);
    expect(s.paneLayout).toBe('solo0');
    expect(s.resourcePollIntervalSeconds).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// load() — numeric field validation
// ---------------------------------------------------------------------------

describe('load() — targetFps validation', () => {
  it('rejects targetFps of 0', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ targetFps: 0 }));
    const s = await importSettings();
    expect(s.targetFps).toBe(60);
  });

  it('rejects negative targetFps', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ targetFps: -5 }));
    const s = await importSettings();
    expect(s.targetFps).toBe(60);
  });

  it('accepts a positive targetFps', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ targetFps: 30 }));
    const s = await importSettings();
    expect(s.targetFps).toBe(30);
  });

  it('rejects non-number targetFps (string)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ targetFps: 'fast' }));
    const s = await importSettings();
    expect(s.targetFps).toBe(60);
  });
});

describe('load() — splitRatio validation', () => {
  it('accepts splitRatio exactly at SPLIT_RATIO_MIN', async () => {
    const { SPLIT_RATIO_MIN } = await importConstants();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ splitRatio: SPLIT_RATIO_MIN }));
    // Re-import after seeding storage
    vi.resetModules();
    const s = (await import('./settings.svelte')).settings;
    expect(s.splitRatio).toBe(SPLIT_RATIO_MIN);
  });

  it('accepts splitRatio exactly at SPLIT_RATIO_MAX', async () => {
    const { SPLIT_RATIO_MAX } = await importConstants();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ splitRatio: SPLIT_RATIO_MAX }));
    vi.resetModules();
    const s = (await import('./settings.svelte')).settings;
    expect(s.splitRatio).toBe(SPLIT_RATIO_MAX);
  });

  it('rejects splitRatio below SPLIT_RATIO_MIN', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ splitRatio: 0.1 }));
    const s = await importSettings();
    expect(s.splitRatio).toBe(0.5); // default
  });

  it('rejects splitRatio above SPLIT_RATIO_MAX', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ splitRatio: 0.9 }));
    const s = await importSettings();
    expect(s.splitRatio).toBe(0.5); // default
  });

  it('rejects non-number splitRatio', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ splitRatio: 'wide' }));
    const s = await importSettings();
    expect(s.splitRatio).toBe(0.5);
  });
});

describe('load() — resourcePollIntervalSeconds validation', () => {
  it('rejects zero', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ resourcePollIntervalSeconds: 0 }));
    const s = await importSettings();
    expect(s.resourcePollIntervalSeconds).toBe(5);
  });

  it('rejects negative', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ resourcePollIntervalSeconds: -1 }));
    const s = await importSettings();
    expect(s.resourcePollIntervalSeconds).toBe(5);
  });

  it('accepts positive value', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ resourcePollIntervalSeconds: 10 }));
    const s = await importSettings();
    expect(s.resourcePollIntervalSeconds).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// load() — deep partial appearance merge
// ---------------------------------------------------------------------------

describe('load() — deep partial appearance merge', () => {
  it('merges ais.track.color when both ais and route sub-objects exist', async () => {
    // Both `ais` and `route` must be present (even if empty) because load()
    // accesses p.appearance?.route.bearing (etc.) without a second `?.` —
    // if route is absent, the access throws TypeError caught by the outer
    // try/catch, discarding ALL settings.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      appearance: { ais: { track: { color: '#ff0000' } }, route: {} },
    }));
    const s = await importSettings();
    const { ais } = s.appearance;

    // Overridden value
    expect(ais.track.color).toBe('#ff0000');
    // Sibling track defaults preserved
    expect(ais.track.width).toBe(2);
    expect(ais.track.style).toBe('solid');
    expect(ais.track.historyHours).toBe(24);
    expect(ais.track.show).toBe(true);
    // ais-level sibling defaults preserved
    expect(ais.vesselColor).toBe('#22c55e');
    expect(ais.cog.color).toBe('#374151');
    expect(ais.cog.width).toBe(1.5);
  });

  it('merges route.bearing.color when both ais and route sub-objects exist', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      appearance: { ais: {}, route: { bearing: { color: '#000000' } } },
    }));
    const s = await importSettings();
    const { route } = s.appearance;

    expect(route.bearing.color).toBe('#000000');
    expect(route.bearing.width).toBe(4);          // default
    expect(route.segment.color).toBe('#e040fb');   // default
    expect(route.highlightColor).toBe('#ef4444');  // default
  });

  it('appearance with route absent — TypeError silently falls back to all defaults', async () => {
    // p.appearance?.route.bearing throws TypeError when appearance is defined
    // but route is undefined (the ?. only guards appearance, not route).
    // The outer try/catch catches it and returns structuredClone(DEFAULTS).
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      appearance: { vesselColor: '#000000' },
    }));
    const s = await importSettings();

    // ALL settings fall back to defaults, including the vesselColor we set
    expect(s.appearance.vesselColor).toBe('#ef4444');
    expect(s.appearance.route.highlightColor).toBe('#ef4444');
  });

  it('appearance with ais absent — TypeError silently falls back to all defaults', async () => {
    // Same bug as above: p.appearance?.ais.cog throws when ais is undefined.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      appearance: { route: { bearing: { color: '#000000' } } },
    }));
    const s = await importSettings();

    expect(s.appearance.route.bearing.color).toBe('#ff6d00'); // default, not '#000000'
  });
});

// ---------------------------------------------------------------------------
// apply() — contract: paneLayout and splitRatio are intentionally excluded
// ---------------------------------------------------------------------------

describe('apply() — silently ignores paneLayout and splitRatio', () => {
  it('apply({paneLayout: "split"}) does NOT change paneLayout', async () => {
    const s = await importSettings();
    expect(s.paneLayout).toBe('solo0');

    s.apply({ paneLayout: 'split' });
    expect(s.paneLayout).toBe('solo0');
  });

  it('apply({splitRatio: 0.3}) does NOT change splitRatio', async () => {
    const s = await importSettings();
    expect(s.splitRatio).toBe(0.5);

    s.apply({ splitRatio: 0.3 });
    expect(s.splitRatio).toBe(0.5);
  });

  it('the omission does not prevent other fields from applying', async () => {
    const s = await importSettings();
    s.apply({ targetFps: 30, paneLayout: 'split' });
    expect(s.targetFps).toBe(30);        // applied
    expect(s.paneLayout).toBe('solo0');   // ignored
  });
});

// ---------------------------------------------------------------------------
// apply() — unguarded numeric fields (documents current behavior)
// ---------------------------------------------------------------------------

describe('apply() — unguarded numeric fields', () => {
  it('apply({targetFps: 0}) persists the invalid value', async () => {
    const s = await importSettings();
    s.apply({ targetFps: 0 });
    expect(s.targetFps).toBe(0);

    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown>;
    expect(raw['targetFps']).toBe(0);
  });

  it('apply({targetFps: -5}) persists the invalid value', async () => {
    const s = await importSettings();
    s.apply({ targetFps: -5 });
    expect(s.targetFps).toBe(-5);
  });

  it('load() self-corrects an invalid persisted targetFps on next page load', async () => {
    const s = await importSettings();
    s.apply({ targetFps: -5 });

    // Simulate page reload: re-import reads from the same localStorage
    vi.resetModules();
    const s2 = (await import('./settings.svelte')).settings;
    expect(s2.targetFps).toBe(60); // load() guard restores default
  });
});

// ---------------------------------------------------------------------------
// setTargetFps() — unguarded (documents current behavior)
// ---------------------------------------------------------------------------

describe('setTargetFps() — unguarded', () => {
  it('setTargetFps(0) persists without validation', async () => {
    const s = await importSettings();
    s.setTargetFps(0);
    expect(s.targetFps).toBe(0);

    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown>;
    expect(raw['targetFps']).toBe(0);
  });

  it('setTargetFps(NaN) persists as null in JSON', async () => {
    const s = await importSettings();
    s.setTargetFps(NaN);
    expect(s.targetFps).toBeNaN();

    // JSON.stringify converts NaN to null
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown>;
    expect(raw['targetFps']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeConnection via apply() — URL pasting and edge cases
// ---------------------------------------------------------------------------

describe('normalizeConnection via apply()', () => {
  it('extracts host, protocol, and port from a pasted https:// URL', async () => {
    const s = await importSettings();
    s.apply({
      signalkHost: 'https://myboat.example.com:3443',
      signalkProtocol: 'ws',
      signalkPort: 80,
    });
    expect(s.host).toBe('myboat.example.com');
    expect(s.port).toBe(3443);
    expect(s.protocol).toBe('wss');
  });

  it('extracts host and protocol from a pasted ws:// URL', async () => {
    const s = await importSettings();
    s.apply({
      signalkHost: 'ws://signal.local:3000',
      signalkProtocol: 'wss',
      signalkPort: 443,
    });
    expect(s.host).toBe('signal.local');
    expect(s.port).toBe(3000);
    expect(s.protocol).toBe('ws');
  });

  it('keeps malformed URL host as-is when URL constructor throws', async () => {
    const s = await importSettings();
    s.apply({
      signalkHost: 'not://a[valid/url',
      signalkProtocol: 'ws',
      signalkPort: 3000,
    });
    // new URL() throws, catch keeps host unchanged
    expect(s.host).toBe('not://a[valid/url');
    expect(s.port).toBe(3000);
  });

  it('trims whitespace from host', async () => {
    const s = await importSettings();
    s.apply({
      signalkHost: '  signal.local  ',
      signalkProtocol: 'ws',
      signalkPort: 3000,
    });
    expect(s.host).toBe('signal.local');
  });

  it('defaults port to 443 for wss when port is invalid', async () => {
    const s = await importSettings();
    s.apply({
      signalkHost: 'myboat.local',
      signalkProtocol: 'wss',
      signalkPort: -1,
    });
    // In http context, normalizedProtocol('wss') returns 'wss' (preserves explicit choice)
    expect(s.port).toBe(443);
  });

  it('defaults port to 80 for ws when port is invalid', async () => {
    const s = await importSettings();
    s.apply({
      signalkHost: 'myboat.local',
      signalkProtocol: 'ws',
      signalkPort: 0,
    });
    expect(s.port).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// setSplitRatio() — clamping
// ---------------------------------------------------------------------------

describe('setSplitRatio() — clamping', () => {
  it('clamps below SPLIT_RATIO_MIN', async () => {
    const { settings, SPLIT_RATIO_MIN } = await importConstants();
    settings.setSplitRatio(0.05);
    expect(settings.splitRatio).toBe(SPLIT_RATIO_MIN);
  });

  it('clamps above SPLIT_RATIO_MAX', async () => {
    const { settings, SPLIT_RATIO_MAX } = await importConstants();
    settings.setSplitRatio(0.95);
    expect(settings.splitRatio).toBe(SPLIT_RATIO_MAX);
  });

  it('persists the clamped value', async () => {
    const { settings, SPLIT_RATIO_MIN } = await importConstants();
    settings.setSplitRatio(0.01);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown>;
    expect(raw['splitRatio']).toBe(SPLIT_RATIO_MIN);
  });
});

// ---------------------------------------------------------------------------
// signalkUrl / signalkHttpUrl — derived URLs
// ---------------------------------------------------------------------------

describe('derived URLs', () => {
  it('signalkUrl includes the correct protocol, host, port and path', async () => {
    const s = await importSettings();
    s.apply({ signalkHost: 'myboat.local', signalkPort: 3000, signalkProtocol: 'ws' });
    expect(s.signalkUrl).toBe('ws://myboat.local:3000/signalk/v1/stream?subscribe=self');
  });

  it('signalkHttpUrl maps ws→http and wss→https', async () => {
    const s = await importSettings();
    s.apply({ signalkHost: 'myboat.local', signalkPort: 3000, signalkProtocol: 'ws' });
    expect(s.signalkHttpUrl).toBe('http://myboat.local:3000');

    s.apply({ signalkProtocol: 'wss' });
    expect(s.signalkHttpUrl).toBe('https://myboat.local:3000');
  });
});

// ---------------------------------------------------------------------------
// apply() — full round-trip persistence
// ---------------------------------------------------------------------------

describe('apply() — persistence round-trip', () => {
  it('persisted appearance survives reload', async () => {
    const s = await importSettings();
    const newAppearance = { ...s.appearance, vesselColor: '#aabbcc' };
    s.apply({ appearance: newAppearance });

    vi.resetModules();
    const s2 = (await import('./settings.svelte')).settings;
    expect(s2.appearance.vesselColor).toBe('#aabbcc');
  });

  it('useGeoLocation persists and reloads', async () => {
    const s = await importSettings();
    expect(s.useGeoLocation).toBe(false);
    s.apply({ useGeoLocation: true });

    vi.resetModules();
    const s2 = (await import('./settings.svelte')).settings;
    expect(s2.useGeoLocation).toBe(true);
  });
});
