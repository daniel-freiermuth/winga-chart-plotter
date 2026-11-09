import { SvelteSet, SvelteMap } from 'svelte/reactivity';
import { fetchCharts, buildTileUrl, type Chart, type ChartRecord } from '../lib/wasmRest';
import { resolveWmtsTileUrl, type WmtsLayerInfo } from '../lib/wmts';
import { pickWmtsTileUrl } from '../lib/wmtsUrl';

export type { Chart };
export type { WmtsLayerInfo };

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS  = 30_000;

function createChartsStore() {
  let available     = $state<ChartRecord>({});
  let loading       = $state(false);
  let error         = $state<string | null>(null);
  let serverBase    = '';
  // Only the latest server's load may commit: a server switch can overlap a
  // previous server's request, which may reject late on its timeout.
  let loadSeq       = 0;
  // Bumped whenever the server base changes; WMTS resolutions started for an
  // older base must not land in the caches of the new one.
  let baseGen       = 0;
  // Loads for the same server share one request (App.svelte starts one from
  // the httpUrl effect and one from the Connected handler).
  let inFlight: Promise<void> | null = null;
  // A failed load retries by itself with backoff: a timeout fires after the
  // WebSocket is up, so the Connected handler's retry never runs again.
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay    = RETRY_BASE_MS;

  // Resolved tile URL templates (SvelteMap → reactive)
  const wmtsResolved      = new SvelteMap<string, string>();
  // Charts where auto-resolution failed
  const wmtsFailed        = new SvelteSet<string>();
  // Charts currently fetching their WMTS capabilities
  const wmtsResolving     = new SvelteSet<string>();
  // All layers from capabilities
  const wmtsAllLayers     = new SvelteMap<string, WmtsLayerInfo[]>();
  // Filtered layers (from chart.layers hint) — empty map entry means "no filter"
  const wmtsFilteredLayers = new SvelteMap<string, WmtsLayerInfo[]>();
  // Charts where user toggled "show all layers"
  const wmtsShowAll       = new SvelteSet<string>();

  function clearRetry(): void {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function scheduleRetry(): void {
    if (retryTimer !== null) return;
    const target = serverBase;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (serverBase === target) void load(target);
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }

  function load(base: string): Promise<void> {
    if (base !== serverBase) {
      // The old server's catalog and WMTS resolutions are void: tileUrl()
      // and styleUrl() would resolve its relative paths against the new
      // base, and same-identifier WMTS charts would reuse old templates.
      // Same-server failures keep the last good catalog.
      serverBase = base;
      baseGen++;
      available  = {};
      wmtsResolved.clear();
      wmtsFailed.clear();
      wmtsResolving.clear();
      wmtsAllLayers.clear();
      wmtsFilteredLayers.clear();
      clearRetry();
      retryDelay = RETRY_BASE_MS;
      error      = null;
    } else if (inFlight) {
      return inFlight;
    }
    const run = runLoad(base, ++loadSeq).finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  }

  async function runLoad(base: string, seq: number): Promise<void> {
    // A retry keeps showing the last failure until it settles.
    if (error === null) loading = true;
    let record: ChartRecord;
    try {
      record = await fetchCharts(base);
    } catch (e) {
      if (seq === loadSeq) {
        error   = String(e);
        loading = false;
        scheduleRetry();
      }
      return;
    }
    if (seq !== loadSeq) return;
    clearRetry();
    retryDelay = RETRY_BASE_MS;
    available  = record;
    error      = null;
    loading    = false;
    const gen  = baseGen;

    // Resolve WMTS capabilities in the background — each chart row updates
    // reactively as its request completes, without blocking the panel.
    const wmtsTasks = Object.values(available)
      .filter(c => c.type === 'WMTS')
      .map(async c => {
        const url = c.url?.startsWith('/') ? `${base}${c.url}` : (c.url ?? '');
        if (!url) { wmtsFailed.add(c.identifier); return; }
        wmtsResolving.add(c.identifier);
        const preferLayer = c.layers?.[0];
        try {
          const info = await resolveWmtsTileUrl(url, preferLayer);
          if (gen !== baseGen) return;
          wmtsResolved.set(c.identifier, info.tileUrlTemplate);
          wmtsAllLayers.set(c.identifier, info.availableLayers);
          // Build filtered list from chart.layers hints (preserving server order).
          // Apply it only if a hinted layer has Web Mercator tiles: otherwise the
          // picker would offer nothing selectable, so show all layers (which
          // include the first-Web-Mercator fallback the chart opens on).
          if (c.layers && c.layers.length > 0) {
            const allById = new Map(info.availableLayers.map(l => [l.id, l]));
            const filtered = c.layers.map(id => allById.get(id)).filter(Boolean) as WmtsLayerInfo[];
            if (filtered.some(l => l.tileUrl !== '')) wmtsFilteredLayers.set(c.identifier, filtered);
          }
        } catch {
          if (gen === baseGen) wmtsFailed.add(c.identifier);
        } finally {
          if (gen === baseGen) wmtsResolving.delete(c.identifier);
        }
      });
    void Promise.allSettled(wmtsTasks);
  }

  return {
    get available():  ChartRecord              { return available;  },
    get loading():    boolean                  { return loading;    },
    get error():      string | null            { return error;      },
    get wmtsFailed():    SvelteSet<string>        { return wmtsFailed;    },
    get wmtsResolving(): SvelteSet<string>        { return wmtsResolving; },
    /** Layers to display in the picker for a given chart id. */
    visibleLayers(id: string): WmtsLayerInfo[] {
      if (wmtsShowAll.has(id)) return wmtsAllLayers.get(id) ?? [];
      return wmtsFilteredLayers.get(id) ?? wmtsAllLayers.get(id) ?? [];
    },

    /** Whether a filter is active (chart.layers was non-empty) and not overridden. */
    hasFilter(id: string): boolean {
      return (wmtsFilteredLayers.get(id)?.length ?? 0) > 0;
    },

    isShowingAll(id: string): boolean { return wmtsShowAll.has(id); },

    toggleShowAll(id: string) {
      if (wmtsShowAll.has(id)) wmtsShowAll.delete(id);
      else wmtsShowAll.add(id);
    },


    /**
     * Tile URL for a chart. For WMTS charts, `paneLayerId` — the calling
     * pane's layer selection — picks that layer's URL from the resolved
     * capabilities; see pickWmtsTileUrl for the precedence rules.
     */
    tileUrl(chart: Chart, paneLayerId?: string): string {
      if (chart.type === 'WMTS') {
        return pickWmtsTileUrl(
          wmtsAllLayers.get(chart.identifier),
          paneLayerId,
          wmtsResolved.get(chart.identifier),
        );
      }
      return buildTileUrl(chart, serverBase) ?? '';
    },

    /**
     * Resolve the chart's MapLibre style against the SK server base (handles
     * relative paths). Signal K mapstyleJSON charts carry the style document in
     * `url`; the vendor `style` field takes precedence when set.
     */
    styleUrl(chart: Chart): string | null {
      const style = chart.style ?? (chart.type === 'mapstyleJSON' ? chart.url : undefined);
      if (!style) return null;
      return style.startsWith('/')
        ? `${serverBase}${style}`
        : style;
    },

    load,
  };
}

export const charts = createChartsStore();
