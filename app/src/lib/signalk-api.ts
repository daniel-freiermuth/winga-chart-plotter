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

/** Resolve a potentially-relative chart tile URL to an absolute URL. */
export function resolveTileUrl(url: string, serverBase: string): string {
  if (url.startsWith('/')) return `${serverBase}${url}`;
  return url;
}
