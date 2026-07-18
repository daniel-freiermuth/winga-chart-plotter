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

export interface PlotterExtensions {
  readonly extensions: SvelteMap<string, ExtensionManifest>;
  readonly layout: WidgetPlacement[];
  readonly openPanel: OpenPanelState | null;

  load(serverBase: string): Promise<void>;

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

function createPlotterExtensions(): PlotterExtensions {
  const extensions = new SvelteMap<string, ExtensionManifest>();
  let layout = $state<WidgetPlacement[]>(loadLayout());
  let openPanel = $state<OpenPanelState | null>(null);

  // ── Instance-state change listeners ───────────────────────────────────────
  // Keyed by "${extensionId}:${instanceId}". When setInstanceState is called
  // (typically by a config panel), all registered handlers are invoked so
  // the corresponding widget connection can republish state.changed.
  const instanceStateListeners = new SvelteMap<string, SvelteSet<(keys: string[]) => void>>();

  // ── Loading ────────────────────────────────────────────────────────────────

  async function load(serverBase: string): Promise<void> {
    const url = `${serverBase}/signalk/v2/api/resources/plotterExtensions`;
    let data: Record<string, unknown>;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      data = (await res.json()) as Record<string, unknown>;
    } catch { return; }

    extensions.clear();

    for (const [id, raw] of Object.entries(data)) {
      const manifest = raw as ExtensionManifest;
      if (manifest.apiVersion !== '1') continue;
      const requires = Array.isArray(manifest.requires) ? manifest.requires : [];
      const satisfied = requires.every((cap) => (HOST_CAPABILITIES as readonly string[]).includes(cap));
      if (!satisfied) continue;
      extensions.set(id, manifest);
    }
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

    load,
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
