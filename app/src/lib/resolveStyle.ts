/**
 * Skippo's glyph server only hosts Roboto variants. Any other font name that
 * appears in a style's text-font property will 404.  This map remaps the most
 * common alternatives to their closest Roboto equivalent so MapLibre never
 * requests a font the server can't serve.
 */
const GLYPH_FONT_MAP: Record<string, string> = {
  'Open Sans Regular':        'Roboto Regular',
  'Open Sans Bold':           'Roboto Bold',
  'Open Sans SemiBold':       'Roboto Medium',
  'Open Sans Italic':         'Roboto Italic',
  'Open Sans Bold Italic':    'Roboto Bold',
  'Arial Unicode MS Regular': 'Roboto Regular',
  'Arial Unicode MS Bold':    'Roboto Bold',
  'Arial Unicode MS':         'Roboto Regular',
};

/**
 * Recursively walk a style JSON tree and substitute any font name strings that
 * are not served by the active glyph server.  Only exact string matches are
 * replaced, so other string values (layer IDs, source names, URLs …) are safe.
 */
function remapGlyphFonts(node: unknown): unknown {
  if (typeof node === 'string') return GLYPH_FONT_MAP[node] ?? node;
  if (Array.isArray(node)) return node.map(remapGlyphFonts);
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = remapGlyphFonts(v);
    }
    return out;
  }
  return node;
}

/**
 * Fetch a MapLibre style JSON URL and resolve any ["config", key] expressions
 * using the style's schema defaults, and substitute unsupported camera expressions
 * with safe literal fallbacks.
 *
 * Background: MapLibre GL JS supports ["config", "key"] expressions as part of
 * its "configurable styles" (style imports) feature. However, when a style is
 * passed directly as an object to map.setStyle() rather than loaded via the
 * "imports" mechanism, config expressions are not resolved and cause an
 * "Unknown expression 'config'" error.
 *
 * Additionally, some styles (e.g. Skippo nautical) use ["pitch"] and
 * ["distance-from-center"] camera expressions in layer filters to cull symbols
 * at high tilt angles and far from the viewport centre. These expressions are
 * not supported in all MapLibre versions. Replacing them with the literal value
 * 0 is safe: at pitch=0 the step/comparison expressions collapse to their
 * "flat map" branch (show everything), which is the correct behaviour for a
 * primarily 2-D navigation chart.
 *
 * Additionally, sources using the mapbox:// protocol (e.g. mapbox.satellite)
 * are stripped out along with any layers that reference them, since MapLibre
 * (unlike MapboxGL JS) cannot resolve mapbox:// URLs without a Mapbox token.
 */
export async function fetchAndResolveStyle(url: string): Promise<object> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch style ${url}: ${String(res.status)} ${res.statusText}`);
  const raw = await res.json() as Record<string, unknown>;

  // Remap unsupported font names before any expression resolution so that
  // the substituted names propagate correctly through step/match outputs.
  const style = remapGlyphFonts(raw) as Record<string, unknown>;

  // Build a defaults map from schema (e.g. { symbolScale: 1, hidePlaces: false, … })
  const schema = style['schema'] as Record<string, { default?: unknown }> | undefined;
  const defaults = new Map<string, unknown>();
  if (schema) {
    for (const [key, def] of Object.entries(schema)) {
      defaults.set(key, def.default);
    }
  }

  const resolved = resolveExprs(style, defaults) as Record<string, unknown>;

  // Strip sources using the mapbox:// protocol — MapLibre cannot resolve them.
  const sources = resolved['sources'] as Record<string, { url?: string; type?: string }> | undefined;
  const strippedSources = new Set<string>();
  if (sources) {
    for (const [id, src] of Object.entries(sources)) {
      if (typeof src.url === 'string' && src.url.startsWith('mapbox://')) {
        strippedSources.add(id);
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- only way to remove a key from the style sources object
        delete sources[id];
      }
    }
  }

  // Remove layers that reference a stripped source, or use the "slot" layer type.
  // "slot" layers are style-composition placeholders from MapLibre's imports system
  // and are not valid render layers when a style is passed directly to setStyle().
  if (Array.isArray(resolved['layers'])) {
    resolved['layers'] = (resolved['layers'] as Record<string, unknown>[])
      .filter(l => l['type'] !== 'slot' && !strippedSources.has(l['source'] as string));
  }

  return resolved;
}

/**
 * Camera expressions that evaluate to a numeric value at the current camera state.
 * These are replaced with 0 (= "flat map, at centre") so that pitch/distance-based
 * visibility filters collapse to their "always visible" branch.
 */
const CAMERA_EXPR_FALLBACK_ZERO = new Set(['pitch', 'distance-from-center']);

function resolveExprs(node: unknown, defaults: Map<string, unknown>): unknown {
  if (!Array.isArray(node)) {
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = resolveExprs(v, defaults);
      }
      return out;
    }
    return node;
  }

  const head: unknown = node[0];

  // ["config", "key"] → schema default value
  if (head === 'config' && node.length === 2 && typeof node[1] === 'string') {
    return defaults.has(node[1]) ? defaults.get(node[1]) : null;
  }

  // ["pitch"] / ["distance-from-center"] → 0
  if (typeof head === 'string' && CAMERA_EXPR_FALLBACK_ZERO.has(head) && node.length === 1) {
    return 0;
  }

  // Resolve children bottom-up, then try to constant-fold arithmetic.
  const resolved = node.map(item => resolveExprs(item, defaults));
  return foldConstants(resolved);
}

/**
 * Constant-fold a single expression node whose children have already been resolved.
 * Only folds when ALL arguments are numeric literals — this is always safe because
 * MapLibre's style imports system would have done the same evaluation at load time.
 *
 * Operators handled: *, /, +, -, coalesce, min, max, abs, ceil, floor, round, ^
 */
function foldConstants(node: unknown[]): unknown {
  const op = node[0];
  if (typeof op !== 'string') return node;

  // A MapLibre expression operator is always a single lowercase word with optional hyphens.
  // Any string containing a space (e.g. "Roboto Regular") is a data value, not an operator.
  // Wrap the whole array in ["literal", ...] so MapLibre treats it as a constant array.
  if (op.includes(' ') && node.every(e => typeof e === 'string')) {
    return ['literal', node];
  }

  if (node.length < 2) return node;

  const args = node.slice(1);
  const allNumbers = args.every(a => typeof a === 'number');

  if (allNumbers) {
    const nums = args;
    switch (op) {
      case '*': return nums.reduce((a, b) => a * b);
      case '/': return nums.length === 2 && nums[1]! !== 0 ? nums[0]! / nums[1]! : node;
      case '+': return nums.reduce((a, b) => a + b);
      case '-': return nums.length === 2 ? nums[0]! - nums[1]! : node;
      case '^': return nums.length === 2 ? Math.pow(nums[0]!, nums[1]!) : node;
      case 'min': return Math.min(...nums);
      case 'max': return Math.max(...nums);
      case 'abs': return nums.length === 1 ? Math.abs(nums[0]!) : node;
      case 'ceil': return nums.length === 1 ? Math.ceil(nums[0]!) : node;
      case 'floor': return nums.length === 1 ? Math.floor(nums[0]!) : node;
      case 'round': return nums.length === 1 ? Math.round(nums[0]!) : node;
    }
  }

  // coalesce: return first non-null argument (args may be mixed types)
  if (op === 'coalesce') {
    const first = args.find(a => a !== null && a !== undefined);
    if (first !== undefined) return first;
  }

  // step/match/case: wrap any plain string-array output values in ["literal", [...]]
  // so MapLibre doesn't try to interpret them as expressions.
  // Example: ["step", ["zoom"], ["Roboto Regular"], 8, ["Roboto Bold"]]
  //       → ["step", ["zoom"], ["literal", ["Roboto Regular"]], 8, ["literal", ["Roboto Bold"]]]
  if (op === 'step') {
    // step: ["step", input, default, stop1, out1, stop2, out2, ...]
    // outputs are at indices 2, 4, 6, ... (relative to full node, so node[2], node[4], ...)
    const out = [...node];
    for (let i = 2; i < out.length; i += 2) {
      out[i] = maybeWrapStringArray(out[i]);
    }
    return out;
  }
  if (op === 'match') {
    // match: ["match", input, val1, out1, val2, out2, ..., default]
    // outputs are at indices 3, 5, 7, ..., and last index
    const out = [...node];
    for (let i = 3; i < out.length - 1; i += 2) {
      out[i] = maybeWrapStringArray(out[i]);
    }
    out[out.length - 1] = maybeWrapStringArray(out[out.length - 1]);
    return out;
  }
  if (op === 'case') {
    // case: ["case", cond1, out1, cond2, out2, ..., default]
    // outputs are at indices 2, 4, 6, ..., and last index
    const out = [...node];
    for (let i = 2; i < out.length - 1; i += 2) {
      out[i] = maybeWrapStringArray(out[i]);
    }
    out[out.length - 1] = maybeWrapStringArray(out[out.length - 1]);
    return out;
  }

  return node;
}

/**
 * If the value is a plain array of strings representing a font name list
 * (e.g. ["Roboto Regular"]), wrap it in ["literal", ...] so MapLibre treats
 * it as a constant value rather than an expression.
 *
 * MapLibre expression operators are always single lowercase words with optional
 * hyphens (e.g. "get", "has", "step", "number-format"). Font names always
 * contain spaces (e.g. "Roboto Regular"). We use the presence of a space in
 * the first element to distinguish data from an operator.
 *
 * This guard prevents wrapping real expressions like ["get", "OBJNAM"] which
 * happen to be all-string arrays.
 */
function maybeWrapStringArray(value: unknown): unknown {
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(e => typeof e === 'string') &&
    typeof value[0] === 'string' &&
    value[0].includes(' ')
  ) {
    return ['literal', value];
  }
  return value;
}

/**
 * Find the first raster tile URL template in a resolved MapLibre style.
 * Checks `tiles[]` on inline sources first; falls back to fetching the
 * TileJSON `url` pointer — exactly what MapLibre does internally.
 * `styleBase` is the style JSON URL, used to resolve relative TileJSON URLs.
 */
export async function extractRasterTileUrl(style: object, styleBase: string): Promise<string | null> {
  const sources = (style as Record<string, unknown>)['sources'];
  if (sources == null || typeof sources !== 'object') return null;
  for (const src of Object.values(sources as Record<string, unknown>)) {
    if (src == null || typeof src !== 'object') continue;
    const s = src as Record<string, unknown>;
    if (s['type'] !== 'raster') continue;
    // Inline tiles array — no extra request needed.
    if (Array.isArray(s['tiles']) && typeof s['tiles'][0] === 'string') {
      return s['tiles'][0];
    }
    // TileJSON url pointer — fetch it the same way MapLibre would.
    if (typeof s['url'] === 'string') {
      const tjUrl = new URL(s['url'], styleBase).href;
      try {
        const res = await fetch(tjUrl);
        if (res.ok) {
          const tj = await res.json() as Record<string, unknown>;
          if (Array.isArray(tj['tiles']) && typeof tj['tiles'][0] === 'string') {
            return tj['tiles'][0];
          }
        }
      } catch { /* network error — try next source */ }
    }
  }
  return null;
}
