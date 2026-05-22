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

/** Fetch a map of vessel URN → vessel name from the REST API. */
export async function fetchVesselNames(serverBase: string): Promise<Map<string, string>> {
  const res = await fetch(`${serverBase}/signalk/v1/api/vessels`);
  if (!res.ok) return new Map();
  const data = await res.json() as Record<string, { name?: string }>;
  const map = new Map<string, string>();
  for (const [urn, vessel] of Object.entries(data)) {
    if (vessel.name) map.set(urn, vessel.name);
  }
  return map;
}

export function resolveTileUrl(url: string, serverBase: string): string {
  if (url.startsWith('/')) return `${serverBase}${url}`;
  return url;
}
