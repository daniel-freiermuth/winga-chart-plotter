import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { randomUuid } from '../lib/uuid';

// ── Manifest types ────────────────────────────────────────────────────────────

export interface WidgetDef {
  id: string;
  title: string;
  type: 'iframe';
  url: string;
  size: string;          // e.g. "1x1", "2x1"
  configPanel?: string;
  lifecycle?: string;
}

export interface PanelDef {
  id: string;
  title: string;
  type: 'iframe';
  url: string;
  lifecycle?: string;
}

export interface ButtonDef {
  id: string;
  title: string;
  slot: string;
  icon?: string;
  action: {
    type: 'togglePanel' | 'openPanel' | 'sendMessage';
    panel?: string;
    topic?: string;
    params?: unknown;
  };
}

export interface ExtensionManifest {
  name: string;
  description?: string;
  version: string;
  apiVersion: string;
  requires: string[];
  optional?: string[];
  widgets?: WidgetDef[];
  panels?: PanelDef[];
  buttons?: ButtonDef[];
}

// ── Layout types ──────────────────────────────────────────────────────────────

/** A widget placed on the map at a free (x, y) position in viewport pixels. */
export interface WidgetPlacement {
  instanceId: string;   // UUID — keys per-instance state
  extensionId: string;
  widgetId: string;
  x: number;            // left offset from map container
  y: number;            // top offset from map container
  w?: number;           // per-instance pixel override (undefined → use WidgetDef.size)
  h?: number;
}

export interface OpenPanelState {
  extensionId: string;
  panelId: string;
  isConfig: boolean;        // true → centered config dialog; false → side panel
  targetInstance?: string;  // set when isConfig=true
  targetWidget?: string;
}

// ── Capabilities ──────────────────────────────────────────────────────────────

export const HOST_CAPABILITIES = [
  'widgets', 'panels.iframe', 'signalk.stream',
  'signalk.put', 'units', 'map', 'ui',
] as const satisfies string[];

// ── localStorage helpers ──────────────────────────────────────────────────────

const LS_LAYOUT_KEY = 'plotterext:layout';

function isValidPlacement(p: unknown): p is WidgetPlacement {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o['instanceId']  === 'string' &&
    typeof o['extensionId'] === 'string' &&
    typeof o['widgetId']    === 'string' &&
    typeof o['x']           === 'number' &&
    typeof o['y']           === 'number'
  );
}

function loadLayout(): WidgetPlacement[] {
  try {
    const raw = localStorage.getItem(LS_LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown[];
      // Filter out old grid-based entries (they have 'area' instead of 'x'/'y').
      return Array.isArray(parsed) ? parsed.filter(isValidPlacement) : [];
    }
  } catch { /* ignore */ }
  return [];
}

function saveLayout(layout: WidgetPlacement[]): void {
  try {
    localStorage.setItem(LS_LAYOUT_KEY, JSON.stringify(layout));
  } catch { /* ignore */ }
}

function lsGet(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as Record<string, unknown>;
  } catch { /* ignore */ }
  return {};
}

function lsSet(key: string, values: Record<string, unknown>): void {
  try {
    const existing = lsGet(key);
    localStorage.setItem(key, JSON.stringify({ ...existing, ...values }));
  } catch { /* ignore */ }
}

// ── Store interface ───────────────────────────────────────────────────────────

/** Lifecycle of the extension-manifest fetch — drives widget placeholders. */
export type ExtensionsStatus =
  /** No load has been attempted for the current server yet. */
  | 'idle'
  /** A request is in flight and nothing usable has arrived yet. */
  | 'loading'
  /** The last load succeeded; `extensions` reflects the server. */
  | 'ready'
  /** The last load failed; a retry is scheduled. Any previously loaded
   *  manifests are retained so widgets survive a server restart. */
  | 'error';

export interface PlotterExtensions {
  readonly extensions: SvelteMap<string, ExtensionManifest>;
  readonly layout: WidgetPlacement[];
  readonly openPanel: OpenPanelState | null;
  readonly status: ExtensionsStatus;
  readonly error: string | null;

  load(serverBase: string): Promise<void>;
  /** Cancel any scheduled retry and load again now (user "retry" action). */
  reload(): void;

  /** Spawn a new widget instance; returns the new instanceId. */
  addWidget(extensionId: string, widgetId: string): string;
  /** Update persisted position after a drag. */
  moveWidget(instanceId: string, x: number, y: number): void;
  /** Update persisted pixel size after a resize. */
  resizeWidget(instanceId: string, w: number, h: number): void;
  removeWidget(instanceId: string): void;

  openPanelFor(state: OpenPanelState): void;
  closePanelFor(): void;
  togglePanelFor(extensionId: string, panelId: string): void;

  getInstanceState(extensionId: string, instanceId: string, keys?: string[]): Record<string, unknown>;
  setInstanceState(extensionId: string, instanceId: string, values: Record<string, unknown>): void;
  /**
   * Subscribe to per-instance state writes from any connection (e.g. a config
   * panel). Returns an unsubscribe function. Used by WidgetCell to republish
   * `state.changed` to the widget's own HostConnection.
   */
  onInstanceStateChanged(extensionId: string, instanceId: string, handler: (keys: string[]) => void): () => void;
  getExtState(extensionId: string, keys?: string[]): Record<string, unknown>;
  setExtState(extensionId: string, values: Record<string, unknown>): void;

  resolveUrl(serverBase: string, manifestUrl: string): string;
}

// ── Store factory ─────────────────────────────────────────────────────────────

// ── Load resilience tuning ────────────────────────────────────────────────────

/** A wedged server must fail the request, not hold it open forever — without
 *  a deadline the retry chain never gets a chance to run. */
const LOAD_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS   = 2_000;
const RETRY_MAX_MS    = 30_000;

/**
 * A widget whose extension disappears from the manifest list vanishes off the
 * chart, so a single absence is not trusted: Signal K registers resource
 * providers asynchronously, and a server that has just restarted happily
 * serves an empty (or partial) list for a few seconds. An extension is only
 * dropped once it is missing from this many consecutive successful loads.
 */
const ABSENT_LOADS_BEFORE_DROP = 2;

/** Bounded re-checks after a load that left placed widgets without a manifest. */
const MAX_INCOMPLETE_RECHECKS = 5;

function createPlotterExtensions(): PlotterExtensions {
  const extensions = new SvelteMap<string, ExtensionManifest>();
  let layout = $state<WidgetPlacement[]>(loadLayout());
  let openPanel = $state<OpenPanelState | null>(null);
  let status = $state<ExtensionsStatus>('idle');
  let error = $state<string | null>(null);

  // ── Instance-state change listeners ───────────────────────────────────────
  // Keyed by "${extensionId}:${instanceId}". When setInstanceState is called
  // (typically by a config panel), all registered handlers are invoked so
  // the corresponding widget connection can republish state.changed.
  const instanceStateListeners = new SvelteMap<string, SvelteSet<(keys: string[]) => void>>();

  // ── Loading ────────────────────────────────────────────────────────────────
  //
  // The extension list is the app's single point of failure for widgets: a
  // failed fetch used to be swallowed, leaving `extensions` empty and every
  // placed widget silently absent until the page was reloaded by hand. It is
  // therefore retried indefinitely with backoff, never cleared on failure, and
  // re-checked whenever the outcome contradicts what the layout expects.

  let base = '';
  /** Guards against a stale in-flight response overwriting a newer server's. */
  let loadSeq = 0;
  let inFlight: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_BASE_MS;
  let incompleteRechecks = 0;
  /** extensionId → consecutive successful loads that did not mention it. */
  const absentStreak = new SvelteMap<string, number>();

  function clearRetry(): void {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function scheduleRetry(delayMs: number): void {
    if (retryTimer !== null) return;
    const target = base;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (base === target) void load(target);
    }, delayMs);
  }

  /** Parse + capability-filter the raw resource document. */
  function parseManifests(data: Record<string, unknown>): SvelteMap<string, ExtensionManifest> {
    const out = new SvelteMap<string, ExtensionManifest>();
    for (const [id, raw] of Object.entries(data)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const manifest = raw as ExtensionManifest;
      if (manifest.apiVersion !== '1') continue;
      const requires = Array.isArray(manifest.requires) ? manifest.requires : [];
      const satisfied = requires.every((cap) => (HOST_CAPABILITIES as readonly string[]).includes(cap));
      if (!satisfied) continue;
      out.set(id, manifest);
    }
    return out;
  }

  /**
   * Merge a freshly loaded set into the live map, touching only what actually
   * changed: rewriting unchanged manifests would churn every widget's props on
   * every poll for nothing.
   */
  function reconcile(fresh: SvelteMap<string, ExtensionManifest>): void {
    for (const [id, manifest] of fresh) {
      absentStreak.delete(id);
      const current = extensions.get(id);
      if (!current || JSON.stringify(current) !== JSON.stringify(manifest)) {
        extensions.set(id, manifest);
      }
    }
    for (const id of [...extensions.keys()]) {
      if (fresh.has(id)) continue;
      const streak = (absentStreak.get(id) ?? 0) + 1;
      absentStreak.set(id, streak);
      if (streak >= ABSENT_LOADS_BEFORE_DROP) {
        absentStreak.delete(id);
        extensions.delete(id);
      }
    }
  }

  /** True when a placed widget has no manifest — the list is behind reality. */
  function layoutUnsatisfied(): boolean {
    return layout.some((p) => !extensions.has(p.extensionId));
  }

  async function load(serverBase: string): Promise<void> {
    if (serverBase !== base) {
      // New server — everything learned about the old one is void.
      base = serverBase;
      clearRetry();
      retryDelay = RETRY_BASE_MS;
      incompleteRechecks = 0;
      absentStreak.clear();
      inFlight = null;
    } else if (inFlight) {
      return inFlight; // single-flight: concurrent callers share one request.
    }

    const seq = ++loadSeq;
    if (status !== 'ready') status = 'loading';
    const run = (async (): Promise<void> => {
      const url = `${serverBase}/signalk/v2/api/resources/plotterExtensions`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${String(res.status)} ${res.statusText}`);
        const data: unknown = await res.json();
        if (seq !== loadSeq) return; // superseded by a newer load
        if (typeof data !== 'object' || data === null) throw new Error('malformed extension list');

        reconcile(parseManifests(data as Record<string, unknown>));
        status = 'ready';
        error = null;
        retryDelay = RETRY_BASE_MS;

        // A successful load that still leaves widgets without a manifest means
        // the server is up but not finished registering — the exact state a
        // restarting Signal K passes through. Re-check a bounded number of
        // times instead of leaving the user staring at missing widgets.
        if (layoutUnsatisfied() && incompleteRechecks < MAX_INCOMPLETE_RECHECKS) {
          incompleteRechecks++;
          scheduleRetry(Math.min(RETRY_BASE_MS * 2 ** (incompleteRechecks - 1), RETRY_MAX_MS));
        } else if (!layoutUnsatisfied()) {
          incompleteRechecks = 0;
        }
      } catch (err) {
        if (seq !== loadSeq) return;
        // Existing manifests are deliberately kept: a widget that is already on
        // screen should ride out a server restart, not disappear.
        status = 'error';
        error = err instanceof Error ? err.message : String(err);
        scheduleRetry(retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      } finally {
        if (seq === loadSeq) inFlight = null;
      }
    })();
    inFlight = run;
    return run;
  }

  function reload(): void {
    clearRetry();
    retryDelay = RETRY_BASE_MS;
    incompleteRechecks = 0;
    if (base) void load(base);
  }

  // ── Layout helpers ─────────────────────────────────────────────────────────

  function addWidget(extensionId: string, widgetId: string): string {
    const instanceId = randomUuid();
    // Stagger so multiple widgets don't land exactly on top of each other.
    const n = layout.length % 6;
    layout = [...layout, { instanceId, extensionId, widgetId, x: 80 + n * 28, y: 80 + n * 28 }];
    saveLayout(layout);
    return instanceId;
  }

  function moveWidget(instanceId: string, x: number, y: number): void {
    layout = layout.map((p) => p.instanceId === instanceId ? { ...p, x, y } : p);
    saveLayout(layout);
  }

  function resizeWidget(instanceId: string, w: number, h: number): void {
    layout = layout.map((p) => p.instanceId === instanceId ? { ...p, w, h } : p);
    saveLayout(layout);
  }

  function removeWidget(instanceId: string): void {
    layout = layout.filter((p) => p.instanceId !== instanceId);
    saveLayout(layout);
  }

  // ── Panel helpers ──────────────────────────────────────────────────────────

  function openPanelFor(state: OpenPanelState): void {
    openPanel = state;
  }

  function closePanelFor(): void {
    openPanel = null;
  }

  function togglePanelFor(extensionId: string, panelId: string): void {
    if (openPanel?.extensionId === extensionId && openPanel.panelId === panelId) {
      openPanel = null;
    } else {
      openPanel = { extensionId, panelId, isConfig: false };
    }
  }

  // ── Instance / extension state ─────────────────────────────────────────────

  function getInstanceState(
    extensionId: string,
    instanceId: string,
    keys?: string[],
  ): Record<string, unknown> {
    const key = `plotterext:state:${extensionId}:${instanceId}`;
    const all = lsGet(key);
    if (!keys) return all;
    return Object.fromEntries(keys.map((k) => [k, all[k]]));
  }

  function setInstanceState(
    extensionId: string,
    instanceId: string,
    values: Record<string, unknown>,
  ): void {
    lsSet(`plotterext:state:${extensionId}:${instanceId}`, values);
    const key = `${extensionId}:${instanceId}`;
    const handlers = instanceStateListeners.get(key);
    if (handlers) {
      const changedKeys = Object.keys(values);
      for (const handler of handlers) {
        try { handler(changedKeys); } catch { /* ignore */ }
      }
    }
  }

  function onInstanceStateChanged(
    extensionId: string,
    instanceId: string,
    handler: (keys: string[]) => void,
  ): () => void {
    const key = `${extensionId}:${instanceId}`;
    let set = instanceStateListeners.get(key);
    if (!set) { set = new SvelteSet(); instanceStateListeners.set(key, set); }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) instanceStateListeners.delete(key);
    };
  }

  function getExtState(extensionId: string, keys?: string[]): Record<string, unknown> {
    const all = lsGet(`plotterext:extstate:${extensionId}`);
    if (!keys) return all;
    return Object.fromEntries(keys.map((k) => [k, all[k]]));
  }

  function setExtState(extensionId: string, values: Record<string, unknown>): void {
    lsSet(`plotterext:extstate:${extensionId}`, values);
  }

  // ── URL resolution ─────────────────────────────────────────────────────────

  function resolveUrl(serverBase: string, manifestUrl: string): string {
    return manifestUrl.startsWith('/') ? serverBase + manifestUrl : manifestUrl;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    get extensions() { return extensions; },
    get layout() { return layout; },
    get openPanel() { return openPanel; },
    get status() { return status; },
    get error() { return error; },

    load,
    reload,
    addWidget,
    moveWidget,
    resizeWidget,
    removeWidget,
    openPanelFor,
    closePanelFor,
    togglePanelFor,
    getInstanceState,
    setInstanceState,
    onInstanceStateChanged,
    getExtState,
    setExtState,
    resolveUrl,
  };
}

export const plotterExtensions = createPlotterExtensions();
