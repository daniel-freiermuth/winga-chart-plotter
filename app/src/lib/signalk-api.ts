/** Chart entry as returned by GET /signalk/v2/api/resources/charts */
export interface Chart {
  identifier: string;
  name: string;
  description?: string;
  /** Base URL for WMS/WMTS, or XYZ tile template for tilelayer */
  url?: string;
  format: string;           // "png" | "jpg" | "pbf" etc.
  type: string;             // "tilelayer" | "WMS" | "WMTS"
  minzoom?: number;
  maxzoom?: number;
  scale?: number;
  bounds?: [number, number, number, number];
  layers?: string[];
  /** WMS version override, e.g. "1.1.1" or "1.3.0" (default: "1.3.0") */
  wmsVersion?: string;
}

export type ChartRecord = Record<string, Chart>;

/**
 * Build a MapLibre-compatible raster tile URL for a chart.
 *
 * - tilelayer / pbf → resolve relative URL, return as-is (already an XYZ template)
 * - WMS            → build a GetMap URL with {bbox-epsg-3857}
 * - WMTS KVP       → build a GetTile URL with {z}/{x}/{y} tokens
 * - WMTS REST      → treat as XYZ (the URL already contains tile path tokens)
 */
export function buildTileUrl(chart: Chart, serverBase: string): string | null {
  if (!chart.url) return null;
  const base = chart.url.startsWith('/') ? `${serverBase}${chart.url}` : chart.url;

  if (chart.type === 'WMS') {
    const layers = chart.layers?.join(',') ?? '';
    const fmt = mimeType(chart.format);
    const ver = chart.wmsVersion ?? '1.3.0';
    // CRS parameter name differs between WMS 1.1.x (SRS) and 1.3.0 (CRS)
    const crsParam = ver.startsWith('1.1') ? 'SRS' : 'CRS';
    const sep = base.includes('?') ? '&' : '?';
    return (
      `${base}${sep}SERVICE=WMS&VERSION=${ver}&REQUEST=GetMap` +
      `&${crsParam}=EPSG:3857&BBOX={bbox-epsg-3857}` +
      `&WIDTH=256&HEIGHT=256` +
      `&LAYERS=${encodeURIComponent(layers)}` +
      `&STYLES=` +
      `&FORMAT=${encodeURIComponent(fmt)}` +
      `&TRANSPARENT=TRUE`
    );
  }

  if (chart.type === 'WMTS') {
    // Detect KVP-style by presence of "?" or absence of "{z}" in URL
    if (!base.includes('{z}')) {
      const layers = chart.layers?.[0] ?? '';
      const fmt = mimeType(chart.format);
      const sep = base.includes('?') ? '&' : '?';
      return (
        `${base}${sep}SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile` +
        `&LAYER=${encodeURIComponent(layers)}` +
        `&TILEMATRIXSET=EPSG:3857&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}` +
        `&FORMAT=${encodeURIComponent(fmt)}`
      );
    }
    // REST-style WMTS already has {z}/{x}/{y} tokens — use as-is
    return base;
  }

  // tilelayer / pbf: already an XYZ template
  return base;
}

function mimeType(format: string): string {
  switch (format.toLowerCase()) {
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'pbf':  return 'application/vnd.mapbox-vector-tile';
    case 'webp': return 'image/webp';
    default:     return `image/${format}`;
  }
}

export async function fetchCharts(serverBase: string): Promise<ChartRecord> {
  const res = await fetch(`${serverBase}/signalk/v2/api/resources/charts`);
  if (!res.ok) throw new Error(`Charts API error: ${String(res.status)} ${res.statusText}`);
  return res.json() as Promise<ChartRecord>;
}

export interface VesselInfo {
  name?: string;
  shipType?: string;
  lengthM?: number;
  beamM?: number;
  draftM?: number;
}

/** Fetch a map of vessel URN → rich vessel info from the REST API. */
export async function fetchVesselInfo(serverBase: string): Promise<Map<string, VesselInfo>> {
  const res = await fetch(`${serverBase}/signalk/v1/api/vessels`);
  if (!res.ok) return new Map();
  const data = await res.json() as Record<string, {
    name?: string;
    design?: {
      aisShipType?: { value?: { name?: string } };
      length?:      { value?: { overall?: number } };
      beam?:        { value?: number };
      draft?:       { value?: { maximum?: number; current?: number } };
    };
  }>;
  const map = new Map<string, VesselInfo>();
  for (const [urn, v] of Object.entries(data)) {
    const des = v.design;
    const info: VesselInfo = {};
    if (v.name)                            info.name     = v.name;
    if (des?.aisShipType?.value?.name)     info.shipType = des.aisShipType.value.name;
    if (des?.length?.value?.overall !== undefined) info.lengthM = des.length.value.overall;
    if (typeof des?.beam?.value === 'number')       info.beamM   = des.beam.value;
    const draft = des?.draft?.value?.current ?? des?.draft?.value?.maximum;
    if (draft !== undefined)               info.draftM = draft;
    map.set(urn, info);
  }
  return map;
}


