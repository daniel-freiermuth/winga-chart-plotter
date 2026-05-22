/** Chart entry as returned by GET /signalk/v2/api/resources/charts */
export interface Chart {
  identifier: string;
  name: string;
  description?: string;
  /** XYZ tile URL — may be relative (starting with /signalk/) */
  url: string;
  format: string;           // "png" | "jpg" | "pbf" etc.
  type: string;             // "tilelayer" | "WMS"
  minzoom?: number;
  maxzoom?: number;
  scale?: number;
  bounds?: [number, number, number, number];
  layers?: string[];
}

export type ChartRecord = Record<string, Chart>;

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

export function resolveTileUrl(url: string, serverBase: string): string {
  if (url.startsWith('/')) return `${serverBase}${url}`;
  return url;
}
