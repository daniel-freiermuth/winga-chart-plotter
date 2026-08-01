import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memStorage } from './testStorage';

/**
 * Boot/seeding behavior of the pane module: pane 1 is cloned from pane 0's
 * live camera exactly once — on the first split enable (or at module init
 * when split view was already persisted as enabled).
 *
 * The `panes` tuple is created at module load, so every test resets the
 * module registry and re-imports with a fresh in-memory localStorage —
 * dynamic `import()` is required here: a static import would hand every
 * test the same already-initialized module instance.
 */

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', memStorage());
  // settings.svelte.ts detects the Signal K origin from window.location at
  // module init; URL is shape-compatible with the fields it reads.
  vi.stubGlobal('window', { location: new URL('http://localhost:5173/') });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pane seeding', () => {
  it('first split enable clones pane 0 camera and projection into pane 1', async () => {
    localStorage.setItem('map-view-coords', JSON.stringify({ center: [5.5, 60.25], zoom: 12, bearing: 45, pitch: 30 }));
    localStorage.setItem('map-view-projection', 'globe');
    const { panes, setSplitViewEnabled } = await import('./pane.svelte');
    expect(panes[1].view.hasSavedView).toBe(false);

    setSplitViewEnabled(true);

    expect(panes[1].view.center).toEqual([5.5, 60.25]);
    expect(panes[1].view.zoom).toBe(12);
    expect(panes[1].view.bearing).toBe(45);
    expect(panes[1].view.pitch).toBe(30);
    expect(panes[1].view.projection).toBe('globe');
    expect(panes[1].view.hasSavedView).toBe(true);
    const { settings } = await import('./settings.svelte');
    expect(settings.splitView).toBe(true);
  });

  it('enabling split never overwrites an existing pane 1 camera', async () => {
    localStorage.setItem('map-view-coords', JSON.stringify({ center: [5, 60], zoom: 12, bearing: 0, pitch: 0 }));
    localStorage.setItem('map-view-coords:1', JSON.stringify({ center: [24, 59], zoom: 8, bearing: 90, pitch: 0 }));
    const { panes, setSplitViewEnabled } = await import('./pane.svelte');

    setSplitViewEnabled(true);

    expect(panes[1].view.center).toEqual([24, 59]);
    expect(panes[1].view.zoom).toBe(8);
    expect(panes[1].view.bearing).toBe(90);
  });

  it('booting with split persisted on seeds pane 1 at module init', async () => {
    // Split enabled but pane-1 keys cleared out-of-band: the module seeds
    // pane 1 before any component renders.
    localStorage.setItem('signalk-chart-settings', JSON.stringify({ splitView: true }));
    localStorage.setItem('map-view-coords', JSON.stringify({ center: [7.7, 54.2], zoom: 10, bearing: 10, pitch: 5 }));
    const { panes } = await import('./pane.svelte');

    expect(panes[1].view.hasSavedView).toBe(true);
    expect(panes[1].view.center).toEqual([7.7, 54.2]);
    expect(panes[1].view.zoom).toBe(10);
  });
});
