import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAndResolveStyle } from './resolveStyle';

type Style = Record<string, unknown>;

function stubFetch(style: Style, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    json: () => Promise.resolve(style),
  })));
}

async function resolve(style: Style): Promise<Style> {
  stubFetch(style);
  return await fetchAndResolveStyle('https://styles.example/style.json') as Style;
}

/** Resolve a single expression placed in a symbol layer's layout. */
async function resolveExpr(expr: unknown, schema?: Record<string, { default?: unknown }>): Promise<unknown> {
  const out = await resolve({
    version: 8,
    ...(schema ? { schema } : {}),
    sources: {},
    layers: [{ id: 'l', type: 'symbol', source: 's', layout: { value: expr } }],
  });
  const [layer] = out['layers'] as { layout: { value: unknown } }[];
  return layer?.layout.value;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAndResolveStyle — fetching', () => {
  it('throws with the status when the style request fails', async () => {
    stubFetch({}, 404);
    await expect(fetchAndResolveStyle('https://styles.example/missing.json'))
      .rejects.toThrow('Failed to fetch style https://styles.example/missing.json: 404 Not Found');
  });
});

describe('fetchAndResolveStyle — config and camera expressions', () => {
  it('replaces ["config", key] with the schema default', async () => {
    expect(await resolveExpr(['config', 'hidePlaces'], { hidePlaces: { default: false } })).toBe(false);
  });

  it('resolves ["config", key] without a schema entry to null', async () => {
    expect(await resolveExpr(['config', 'unknownKey'])).toBeNull();
  });

  it('lets coalesce fall through an unresolved config key to the constant fallback', async () => {
    expect(await resolveExpr(['coalesce', ['config', 'unknownKey'], 3])).toBe(3);
  });

  it('replaces ["pitch"] and ["distance-from-center"] with 0', async () => {
    expect(await resolveExpr(['all', ['<', ['pitch'], 60], ['<', ['distance-from-center'], 2]]))
      .toEqual(['all', ['<', 0, 60], ['<', 0, 2]]);
  });
});

describe('fetchAndResolveStyle — numeric constant folding', () => {
  it('folds arithmetic over resolved config defaults', async () => {
    expect(await resolveExpr(['*', ['config', 'symbolScale'], 12], { symbolScale: { default: 1.5 } })).toBe(18);
  });

  it.each([
    [['+', 1, 2, 3], 6],
    [['-', 10, 4], 6],
    [['/', 9, 3], 3],
    [['^', 2, 3], 8],
    [['min', 4, 2, 7], 2],
    [['max', 4, 2, 7], 7],
    [['abs', -3], 3],
    [['ceil', 1.2], 2],
    [['floor', 1.8], 1],
    [['round', 1.5], 2],
  ])('folds %j to %j', async (expr, expected) => {
    expect(await resolveExpr(expr)).toBe(expected);
  });

  it.each([
    ['division by zero', ['/', 1, 0]],
    ['unary minus', ['-', 5]],
    ['"^" with the wrong arity', ['^', 2, 3, 4]],
    ['a non-numeric argument', ['*', ['get', 'size'], 2]],
  ])('leaves %s unfolded', async (_label, expr) => {
    expect(await resolveExpr(expr)).toEqual(expr);
  });
});

describe('fetchAndResolveStyle — literal font arrays', () => {
  it('remaps fonts the glyph server cannot serve to Roboto equivalents', async () => {
    expect(await resolveExpr(['step', ['zoom'], ['Open Sans Regular'], 8, ['Open Sans Bold']]))
      .toEqual(['step', ['zoom'], ['literal', ['Roboto Regular']], 8, ['literal', ['Roboto Bold']]]);
  });

  it('wraps bare font arrays in case outputs but leaves all-string expressions alone', async () => {
    expect(await resolveExpr(['case', ['has', 'OBJNAM'], ['Roboto Bold'], ['Roboto Regular']]))
      .toEqual(['case', ['has', 'OBJNAM'], ['literal', ['Roboto Bold']], ['literal', ['Roboto Regular']]]);
  });
});

describe('fetchAndResolveStyle — mapbox:// and slot stripping', () => {
  it('removes mapbox:// sources, the layers that use them, and slot layers', async () => {
    const out = await resolve({
      version: 8,
      sources: {
        satellite: { type: 'raster', url: 'mapbox://mapbox.satellite' },
        charts: { type: 'vector', url: 'https://tiles.example/charts.json' },
      },
      layers: [
        { id: 'sat', type: 'raster', source: 'satellite' },
        { id: 'middle', type: 'slot' },
        { id: 'depth', type: 'fill', source: 'charts' },
        { id: 'bg', type: 'background' },
      ],
    });
    expect(Object.keys(out['sources'] as object)).toEqual(['charts']);
    expect((out['layers'] as { id: string }[]).map(l => l.id)).toEqual(['depth', 'bg']);
  });
});
