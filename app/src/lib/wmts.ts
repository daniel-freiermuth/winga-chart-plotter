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

  const sep = baseUrl.includes('?') ? '&' : '?';

  // Build a tile URL for each layer so the picker can show per-layer previews
  // without re-fetching capabilities (works for both REST and KVP WMTS).
  const availableLayers = layers.map(l => ({
    id:      qs(l, 'Identifier') ?? '',
    title:   qs(l, 'Title') ?? qs(l, 'Identifier') ?? '',
    tileUrl: layerTileUrl(l, baseUrl, sep, compatibleTms),
  }));

  const targetLayer = pickLayer(layers, compatibleTms, preferLayer);
  return buildInfo(baseUrl, sep, targetLayer, compatibleTms, availableLayers);
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

  // Prefer REST-style ResourceURL when available
  const resourceUrl = targetLayer.querySelector('ResourceURL[resourceType="tile"]');
  if (resourceUrl) {
    const template = resourceUrl.getAttribute('template') ?? '';
    const tileUrlTemplate = template
      .replace(/\{TileMatrixSet\}/g, tmsId)
      .replace(/\{TileMatrix\}/g,    `${compatibleTms.get(tmsId) ?? ''}{z}`)
      .replace(/\{TileRow\}/g,       '{y}')
      .replace(/\{TileCol\}/g,       '{x}');
    return { tileUrlTemplate, layerName, tileMatrixSet: tmsId, format: fmt, availableLayers };
  }

  // KVP-style fallback
  const tileUrlTemplate =
    `${baseUrl}${sep}SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile` +
    `&LAYER=${encodeURIComponent(layerName)}` +
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
 * A set without TileMatrix children yields '' (identifiers assumed to be zooms).
 */
function tileMatrixPrefix(tms: Element): string | null {
  const ids = Array.from(tms.children)
    .filter(c => c.localName === 'TileMatrix')
    .map(m => Array.from(m.children).find(c => c.localName === 'Identifier')?.textContent ?? '');
  if (ids.length === 0) return '';
  const first = ids[0] ?? '';
  if (!first.endsWith('0')) return null;
  const prefix = first.slice(0, -1);
  return ids.every((m, z) => m === `${prefix}${String(z)}`) ? prefix : null;
}

function pickLayer(
  layers: Element[],
  compatibleTms: Map<string, string>,
  preferLayer?: string,
): Element {
  // First try: exact preferred layer
  if (preferLayer) {
    const found = layers.find(l => qs(l, 'Identifier') === preferLayer);
    if (found) return found;
  }
  // Second try: first layer that links to a compatible TMS
  for (const l of layers) {
    for (const link of l.querySelectorAll('TileMatrixSetLink > TileMatrixSet')) {
      if (compatibleTms.has(link.textContent)) return l;
    }
  }
  // Last resort: just return the first layer
  return layers[0]!;
}

function pickTileMatrixSet(layer: Element, compatibleTms: Map<string, string>): string {
  for (const link of layer.querySelectorAll('TileMatrixSetLink > TileMatrixSet')) {
    const id = link.textContent;
    if (compatibleTms.has(id)) return id;
  }
  return compatibleTms.keys().next().value ?? 'WebMercatorQuad';
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

  const resourceUrl = layer.querySelector('ResourceURL[resourceType="tile"]');
  if (resourceUrl) {
    const template = resourceUrl.getAttribute('template') ?? '';
    return template
      .replace(/\{TileMatrixSet\}/g, tmsId)
      .replace(/\{TileMatrix\}/g,    `${compatibleTms.get(tmsId) ?? ''}{z}`)
      .replace(/\{TileRow\}/g,       '{y}')
      .replace(/\{TileCol\}/g,       '{x}');
  }

  return `${baseUrl}${sep}SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile` +
    `&LAYER=${encodeURIComponent(layerName)}` +
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
