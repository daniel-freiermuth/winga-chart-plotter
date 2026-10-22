export interface WmtsLayerInfo {
  id: string;
  title: string;
  /** MapLibre-compatible tile URL template ({z}/{x}/{y}) for this specific layer. */
  tileUrl: string;
}

export interface WmtsInfo {
  /** MapLibre-compatible tile URL with {z}/{x}/{y} tokens */
  tileUrlTemplate: string;
  layerName: string;
  tileMatrixSet: string;
  format: string;
  availableLayers: WmtsLayerInfo[];
}

async function fetchAndParse(
  baseUrl: string,
  preferLayer?: string,
): Promise<WmtsInfo> {
  const base = baseUrl.replace(/\/+$/, '');
  const candidates = [
    // KVP
    `${base}${base.includes('?') ? '&' : '?'}SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities`,
    // REST — common paths
    `${base}/WMTSCapabilities.xml`,
    `${base}/1.0.0/WMTSCapabilities.xml`,
  ];

  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) { errors.push(`${url} → ${String(res.status)}`); continue; }
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (!doc.querySelector('Capabilities, WMT_MS_Capabilities')) {
        errors.push(`${url} → not a WMTS capabilities document`); continue;
      }
      return parseDoc(doc, baseUrl, preferLayer);
    } catch (e) {
      errors.push(`${url} → ${String(e)}`);
    }
  }
  throw new Error(`WMTS GetCapabilities failed:\n${errors.join('\n')}`);
}

export function parseDoc(doc: Document, baseUrl: string, preferLayer?: string): WmtsInfo {
  const compatibleTms = findCompatibleTileMatrixSets(doc);
  if (compatibleTms.size === 0) throw new Error('No EPSG:3857 / WebMercatorQuad tile matrix sets');

  const layers = Array.from(doc.querySelectorAll('Contents > Layer'));
  if (layers.length === 0) throw new Error('No layers in capabilities document');

  // A pasted GetCapabilities URL carries SERVICE/REQUEST/VERSION; appending
  // REQUEST=GetTile after them makes first-value-wins servers (GeoServer,
  // MapProxy) answer every tile with capabilities XML.
  const kvpBase = stripOperationParams(baseUrl);
  const sep = kvpBase.includes('?') ? '&' : '?';

  // Build a tile URL for each layer so the picker can show per-layer previews
  // without re-fetching capabilities (works for both REST and KVP WMTS).
  const availableLayers = layers.map(l => ({
    id:      qs(l, 'Identifier') ?? '',
    title:   qs(l, 'Title') ?? qs(l, 'Identifier') ?? '',
    tileUrl: layerTileUrl(l, kvpBase, sep, compatibleTms),
  }));

  const targetLayer = pickLayer(layers, compatibleTms, preferLayer);
  return buildInfo(kvpBase, sep, targetLayer, compatibleTms, availableLayers);
}


function buildInfo(
  baseUrl: string,
  sep: string,
  targetLayer: Element,
  compatibleTms: Map<string, string>,
  availableLayers: WmtsLayerInfo[],
): WmtsInfo {
  const layerName = qs(targetLayer, 'Identifier') ?? '';
  const fmt       = qs(targetLayer, 'Format') ?? 'image/png';
  const tmsId     = pickTileMatrixSet(targetLayer, compatibleTms);
  if (tmsId === null) {
    throw new Error(`Layer "${layerName}" links no EPSG:3857 / WebMercatorQuad tile matrix set`);
  }

  // Prefer REST-style ResourceURL when available. A ResourceURL without a
  // usable `template` is not a REST endpoint — fall through to KVP.
  const restUrl = restTileUrl(targetLayer, tmsId, compatibleTms.get(tmsId) ?? '');
  if (restUrl !== null) {
    return { tileUrlTemplate: restUrl, layerName, tileMatrixSet: tmsId, format: fmt, availableLayers };
  }

  // KVP-style fallback
  const tileUrlTemplate =
    `${baseUrl}${sep}SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile` +
    `&LAYER=${encodeURIComponent(layerName)}` +
    kvpStyleParam(targetLayer) +
    `&TILEMATRIXSET=${encodeURIComponent(tmsId)}` +
    `&TILEMATRIX=${encodeURIComponent(compatibleTms.get(tmsId) ?? '')}{z}` +
    `&TILEROW={y}&TILECOL={x}` +
    `&FORMAT=${encodeURIComponent(fmt)}`;

  return { tileUrlTemplate, layerName, tileMatrixSet: tmsId, format: fmt, availableLayers };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * TileMatrixSets that use EPSG:3857 or WebMercatorQuad, mapped to the prefix
 * that turns a zoom level into the set's TileMatrix identifier. WMTS TILEMATRIX
 * is an identifier, not a zoom integer: GeoWebCache names its matrices
 * 'EPSG:900913:0'…'EPSG:900913:N' (prefix 'EPSG:900913:'). Sets whose matrix
 * identifiers are not `<prefix>0`…`<prefix>N` in order cannot be addressed by
 * a {z} template and are skipped.
 */
function findCompatibleTileMatrixSets(doc: Document): Map<string, string> {
  const result = new Map<string, string>();
  for (const tms of doc.querySelectorAll('Contents > TileMatrixSet')) {
    const id  = qs(tms, 'Identifier') ?? '';
    const crs = qs(tms, 'SupportedCRS') ?? '';
    if (
      id === 'WebMercatorQuad' ||
      id === 'GoogleMapsCompatible' ||
      crs.includes('3857') ||
      crs.includes('900913')
    ) {
      const prefix = tileMatrixPrefix(tms);
      if (prefix !== null) result.set(id, prefix);
    }
  }
  return result;
}

/**
 * Common prefix of the set's TileMatrix identifiers when they read
 * `<prefix>0`, `<prefix>1`, … in document order; null otherwise.
 * Pure integer identifiers whose value is the zoom yield '' even when
 * zero-padded: MapProxy names its matrices '00', '01', … and parses
 * TILEMATRIX / {TileMatrix} as an integer.
 * A set without TileMatrix children yields '' (identifiers assumed to be zooms).
 */
function tileMatrixPrefix(tms: Element): string | null {
  const ids = Array.from(tms.children)
    .filter(c => c.localName === 'TileMatrix')
    .map(m => Array.from(m.children).find(c => c.localName === 'Identifier')?.textContent ?? '');
  if (ids.length === 0) return '';
  if (ids.every((m, z) => /^\d+$/.test(m) && Number(m) === z)) return '';
  // Strip the whole trailing number so a prefix never ends in a digit: '10'
  // must not read as prefix '1' + zoom 0.
  const prefix = (ids[0] ?? '').replace(/\d+$/, '');
  return ids.every((m, z) => m === `${prefix}${String(z)}`) ? prefix : null;
}

/** KVP keys that identify the WMTS operation; matched case-insensitively per OGC KVP rules. */
const OPERATION_PARAMS: Record<string, true> = { SERVICE: true, REQUEST: true, VERSION: true };

/** Remove SERVICE/REQUEST/VERSION from the query string, keeping all other params (e.g. API keys). */
function stripOperationParams(baseUrl: string): string {
  const q = baseUrl.indexOf('?');
  if (q < 0) return baseUrl;
  const kept = baseUrl
    .slice(q + 1)
    .split('&')
    .filter(p => p !== '' && OPERATION_PARAMS[(p.split('=', 1)[0] ?? '').toUpperCase()] !== true);
  const path = baseUrl.slice(0, q);
  return kept.length > 0 ? `${path}?${kept.join('&')}` : path;
}

function pickLayer(
  layers: Element[],
  compatibleTms: Map<string, string>,
  preferLayer?: string,
): Element {
  // First try: exact preferred layer, if it links a compatible TMS. A hint
  // naming a layer served only on other grids falls through like an absent
  // hint, so the rest of the service stays usable.
  if (preferLayer) {
    const found = layers.find(l => qs(l, 'Identifier') === preferLayer);
    if (found && pickTileMatrixSet(found, compatibleTms) !== null) return found;
  }
  // Second try: first layer that links to a compatible TMS
  for (const l of layers) {
    for (const link of l.querySelectorAll('TileMatrixSetLink > TileMatrixSet')) {
      if (compatibleTms.has(link.textContent)) return l;
    }
  }
  throw new Error('No layer links an EPSG:3857 / WebMercatorQuad tile matrix set');
}

/**
 * The first compatible TMS this layer declares via TileMatrixSetLink, or null.
 * Never substitutes another TMS from the document: the service only serves a
 * layer on the grids it links, so any other TMS yields wrong-grid or 404 tiles.
 */
function pickTileMatrixSet(layer: Element, compatibleTms: Map<string, string>): string | null {
  for (const link of layer.querySelectorAll('TileMatrixSetLink > TileMatrixSet')) {
    const id = link.textContent;
    if (compatibleTms.has(id)) return id;
  }
  return null;
}

/** Identifier of the layer's default <Style> (isDefault="true", else the first one), or null. */
function defaultStyle(layer: Element): string | null {
  const style = layer.querySelector('Style[isDefault="true"]') ?? layer.querySelector('Style');
  return style ? qs(style, 'Identifier') : null;
}

/** `&STYLE=…` for KVP GetTile (mandatory in WMTS 1.0.0); empty when the layer declares no style. */
function kvpStyleParam(layer: Element): string {
  const style = defaultStyle(layer);
  return style === null ? '' : `&STYLE=${encodeURIComponent(style)}`;
}

/**
 * Expand a REST ResourceURL template into a MapLibre {z}/{x}/{y} template.
 * Template variables match case-insensitively (GeoServer emits `{style}`).
 * {Style} and one variable per <Dimension> take the layer's default values;
 * unknown variables are left untouched. `tileMatrixPrefix` turns {z} into the
 * set's TileMatrix identifier (see findCompatibleTileMatrixSets).
 */
function expandResourceTemplate(
  template: string,
  layer: Element,
  tmsId: string,
  tileMatrixPrefix: string,
): string {
  const values = new Map<string, string>([
    ['tilematrixset', tmsId],
    ['tilematrix',    `${tileMatrixPrefix}{z}`],
    ['tilerow',       '{y}'],
    ['tilecol',       '{x}'],
  ]);
  const style = defaultStyle(layer);
  if (style !== null) values.set('style', style);
  for (const dim of layer.querySelectorAll('Dimension')) {
    const id  = qs(dim, 'Identifier')?.toLowerCase();
    const def = qs(dim, 'Default');
    if (id && def !== null && !values.has(id)) values.set(id, def);
  }
  return template.replace(/\{([^{}]+)\}/g, (m, name: string) => values.get(name.toLowerCase()) ?? m);
}

/**
 * Expanded REST tile URL for a layer, or null when it has no tile ResourceURL
 * with a `template`. Layers may list several tile templates (GIBS lists a
 * `{Time}` variant first even for layers without a <Dimension>); the first one
 * whose variables all resolve wins, else the first expanded one.
 */
function restTileUrl(layer: Element, tmsId: string, tileMatrixPrefix: string): string | null {
  let first: string | null = null;
  for (const res of layer.querySelectorAll('ResourceURL[resourceType="tile"]')) {
    const template = res.getAttribute('template');
    if (!template) continue;
    const url = expandResourceTemplate(template, layer, tmsId, tileMatrixPrefix);
    if (!/\{(?![zxy]\})[^{}]+\}/.test(url)) return url;
    first ??= url;
  }
  return first;
}

/**
 * Build a MapLibre-compatible tile URL template for a single layer element.
 * Handles both REST-style (ResourceURL) and KVP-style WMTS services.
 */
function layerTileUrl(
  layer: Element,
  baseUrl: string,
  sep: string,
  compatibleTms: Map<string, string>,
): string {
  const layerName = qs(layer, 'Identifier') ?? '';
  const fmt       = qs(layer, 'Format') ?? 'image/png';
  const tmsId     = pickTileMatrixSet(layer, compatibleTms);
  // No compatible grid for this layer: '' is the "no usable URL" value the
  // picker and pickWmtsTileUrl skip.
  if (tmsId === null) return '';

  const restUrl = restTileUrl(layer, tmsId, compatibleTms.get(tmsId) ?? '');
  if (restUrl !== null) return restUrl;

  return `${baseUrl}${sep}SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile` +
    `&LAYER=${encodeURIComponent(layerName)}` +
    kvpStyleParam(layer) +
    `&TILEMATRIXSET=${encodeURIComponent(tmsId)}` +
    `&TILEMATRIX=${encodeURIComponent(compatibleTms.get(tmsId) ?? '')}{z}` +
    `&TILEROW={y}&TILECOL={x}` +
    `&FORMAT=${encodeURIComponent(fmt)}`;
}

/** Query selector shorthand that returns the element's text content */
function qs(el: Element | Document, selector: string): string | null {
  return el.querySelector(selector)?.textContent ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function resolveWmtsTileUrl(baseUrl: string, preferLayer?: string): Promise<WmtsInfo> {
  return fetchAndParse(baseUrl, preferLayer);
}

export function resolveWmtsLayer(baseUrl: string, layerId: string): Promise<WmtsInfo> {
  return fetchAndParse(baseUrl, layerId);
}
