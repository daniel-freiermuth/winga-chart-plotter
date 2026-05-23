/**
 * WMTS GetCapabilities parser.
 *
 * Fetches and parses a WMTS capabilities document, returning a MapLibre-compatible
 * XYZ tile URL template and the resolved layer / format info.
 */

export interface WmtsLayerInfo {
  id: string;
  title: string;
}

export interface WmtsInfo {
  /** MapLibre-compatible tile URL with {z}/{x}/{y} tokens */
  tileUrlTemplate: string;
  layerName: string;
  tileMatrixSet: string;
  format: string;   // mime type, e.g. "image/png"
  /** All layers available from the service */
  availableLayers: WmtsLayerInfo[];
}

/**
 * Fetch WMTS GetCapabilities and return a resolved MapLibre tile URL.
 *
 * @param baseUrl     The WMTS service base URL (no query string needed)
 * @param preferLayer Optional layer identifier to prefer; otherwise the first
 *                    layer compatible with EPSG:3857 / WebMercatorQuad is used.
 */
export async function resolveWmtsTileUrl(
  baseUrl: string,
  preferLayer?: string,
): Promise<WmtsInfo> {
  const doc = await fetchCapabilities(baseUrl);

  const compatibleTms = findCompatibleTileMatrixSets(doc);
  if (compatibleTms.size === 0) {
    throw new Error('WMTS service has no EPSG:3857 / WebMercatorQuad tile matrix sets');
  }

  const layers = Array.from(doc.querySelectorAll('Contents > Layer'));
  if (layers.length === 0) throw new Error('WMTS service returned no layers');

  const availableLayers: WmtsLayerInfo[] = layers.map(l => ({
    id:    qs(l, 'Identifier') ?? '',
    title: qs(l, 'Title')      ?? qs(l, 'Identifier') ?? '',
  }));

  // Pick the preferred or first layer that links to a compatible TileMatrixSet
  const targetLayer = pickLayer(layers, compatibleTms, preferLayer);
  const sep = baseUrl.includes('?') ? '&' : '?';
  return buildInfo(baseUrl, sep, targetLayer, compatibleTms, availableLayers);
}

/**
 * Build a WmtsInfo for a specific layer identifier, re-fetching capabilities.
 */
export async function resolveWmtsLayer(
  baseUrl: string,
  layerId: string,
): Promise<WmtsInfo> {
  const doc = await fetchCapabilities(baseUrl);

  const compatibleTms = findCompatibleTileMatrixSets(doc);
  const layers        = Array.from(doc.querySelectorAll('Contents > Layer'));

  const availableLayers: WmtsLayerInfo[] = layers.map(l => ({
    id:    qs(l, 'Identifier') ?? '',
    title: qs(l, 'Title')      ?? qs(l, 'Identifier') ?? '',
  }));

  const targetLayer = pickLayer(layers, compatibleTms, layerId);
  const sep = baseUrl.includes('?') ? '&' : '?';
  return buildInfo(baseUrl, sep, targetLayer, compatibleTms, availableLayers);
}

// ---------------------------------------------------------------------------
// Capabilities fetcher — tries KVP then REST endpoint
// ---------------------------------------------------------------------------

/**
 * Fetch and parse a WMTS GetCapabilities document.
 * Tries KVP style first (?SERVICE=WMTS&REQUEST=GetCapabilities),
 * then REST style (/WMTSCapabilities.xml and /1.0.0/WMTSCapabilities.xml).
 */
async function fetchCapabilities(baseUrl: string): Promise<Document> {
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
      const res = await fetch(url);
      if (!res.ok) { errors.push(`${url} → ${res.status}`); continue; }
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      // Confirm it's actually a capabilities doc
      if (doc.querySelector('Capabilities, WMT_MS_Capabilities')) return doc;
      errors.push(`${url} → not a WMTS capabilities document`);
    } catch (e) {
      errors.push(`${url} → ${String(e)}`);
    }
  }
  throw new Error(`WMTS GetCapabilities failed:\n${errors.join('\n')}`);
}

// ---------------------------------------------------------------------------
// Shared builder
// ---------------------------------------------------------------------------

function buildInfo(
  baseUrl: string,
  sep: string,
  targetLayer: Element,
  compatibleTms: Set<string>,
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
      .replace(/\{TileMatrix\}/g,    '{z}')
      .replace(/\{TileRow\}/g,       '{y}')
      .replace(/\{TileCol\}/g,       '{x}');
    return { tileUrlTemplate, layerName, tileMatrixSet: tmsId, format: fmt, availableLayers };
  }

  // KVP-style fallback
  const tileUrlTemplate =
    `${baseUrl}${sep}SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile` +
    `&LAYER=${encodeURIComponent(layerName)}` +
    `&TILEMATRIXSET=${encodeURIComponent(tmsId)}` +
    `&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}` +
    `&FORMAT=${encodeURIComponent(fmt)}`;

  return { tileUrlTemplate, layerName, tileMatrixSet: tmsId, format: fmt, availableLayers };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Identifiers of TileMatrixSets that use EPSG:3857 or WebMercatorQuad */
function findCompatibleTileMatrixSets(doc: Document): Set<string> {
  const result = new Set<string>();
  for (const tms of doc.querySelectorAll('Contents > TileMatrixSet')) {
    const id  = qs(tms, 'Identifier') ?? '';
    const crs = qs(tms, 'SupportedCRS') ?? '';
    if (
      id === 'WebMercatorQuad' ||
      id === 'GoogleMapsCompatible' ||
      crs.includes('3857') ||
      crs.includes('900913')
    ) {
      result.add(id);
    }
  }
  return result;
}

function pickLayer(
  layers: Element[],
  compatibleTms: Set<string>,
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
      if (compatibleTms.has(link.textContent ?? '')) return l;
    }
  }
  // Last resort: just return the first layer
  return layers[0];
}

function pickTileMatrixSet(layer: Element, compatibleTms: Set<string>): string {
  for (const link of layer.querySelectorAll('TileMatrixSetLink > TileMatrixSet')) {
    const id = link.textContent ?? '';
    if (compatibleTms.has(id)) return id;
  }
  return compatibleTms.values().next().value ?? 'WebMercatorQuad';
}

/** Query selector shorthand that returns the element's text content */
function qs(el: Element | Document, selector: string): string | null {
  return el.querySelector(selector)?.textContent ?? null;
}
