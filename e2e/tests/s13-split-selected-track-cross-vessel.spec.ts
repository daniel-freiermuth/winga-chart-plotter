/**
 * S13 — in split view, a pane must never join two vessels' tracks into one line.
 *
 * The AIS selection is app-global (stores/ais.svelte.ts), but each pane keeps its
 * own selected-vessel track (Map.svelte `aisTrackRaw`), which only the pane's own
 * click handler resets. Every pane's live-extension effect appends the selected
 * vessel's live position to its track every 5 s. Select vessel Y in pane A, then
 * vessel X in pane A: pane B still holds Y's points and appends X's live position,
 * drawing a line from Y to X — a track neither vessel sailed.
 *
 * Oracle: the AIS track is painted pure magenta (width 6); pixels are counted in
 * pane B along the gap between Y and X, where no track may exist. Both vessels
 * are stationary, so the only way a line can appear there is the cross-vessel join.
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, lonLatAtPx, pxOffset, VIEW } from '../lib/app';

const Y_ID = 'urn:mrn:imo:mmsi:257000131';
const X_ID = 'urn:mrn:imo:mmsi:257000132';

/** Page point of a lon/lat in the pane whose container matches `paneSel` (camera at VIEW). */
async function panePoint(page: Page, paneSel: string, lon: number, lat: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(`${paneSel} .maplibregl-canvas`).boundingBox();
  if (!box) throw new Error(`${paneSel}: map canvas not laid out`);
  const { dx, dy } = pxOffset(VIEW, lon, lat);
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}

/** Count magenta-ish pixels inside the page rectangle (x, y, w, h). */
async function magentaPixels(page: Page, x: number, y: number, w: number, h: number): Promise<number> {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({ b64, rx, ry, rw, rh }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(rx, ry, rw, rh).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if ((d[i] ?? 0) > 200 && (d[i + 1] ?? 255) < 90 && (d[i + 2] ?? 0) > 200) n++;
    }
    return n;
  }, { b64: png, rx: Math.round(x), ry: Math.round(y), rw: Math.round(w), rh: Math.round(h) });
}

test('split view: selecting another vessel never joins the previous vessel\'s track to it', async ({ page }) => {
  const mock = new MockSignalK();
  const port = await mock.start();

  try {
    await seedApp(page, { port });
    // Open split view with pane B on the same camera, and paint AIS tracks magenta.
    await page.addInitScript((v) => {
      const s = JSON.parse(localStorage.getItem('signalk-chart-settings') ?? '{}') as Record<string, unknown>;
      localStorage.setItem('signalk-chart-settings', JSON.stringify({
        ...s,
        paneLayout: 'split',
        appearance: { ais: { track: { show: true, color: '#ff00ff', width: 6, style: 'solid', historyHours: 24 } } },
      }));
      localStorage.setItem('map-view-coords:1', JSON.stringify({ center: [v.lon, v.lat], zoom: v.zoom, bearing: 0 }));
      localStorage.setItem('map-view-projection:1', 'mercator');
    }, VIEW);
    await blockExternalTiles(page);

    // Own vessel exactly at the view centre (no auto-flyTo camera move). Y and X
    // stationary, 300 px apart on a line 120 px south of the centre.
    const own = { lon: VIEW.lon, lat: VIEW.lat };
    const y = lonLatAtPx(VIEW, -150, 120);
    const x = lonLatAtPx(VIEW, 150, 120);

    await page.goto('/');
    mock.every(1000, () => {
      mock.ownNav({ lon: own.lon, lat: own.lat, cogRad: Math.PI / 2, sogMs: 0 });
      mock.aisReport(Y_ID, { lon: y.lon, lat: y.lat, cogRad: 0, sogMs: 0, name: 'YANKEE' });
      mock.aisReport(X_ID, { lon: x.lon, lat: x.lat, cogRad: 0, sogMs: 0, name: 'XRAY' });
    });

    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', 'rgb(74, 222, 128)', { timeout: 20_000 });
    await expect(page.locator('#pane-second .maplibregl-canvas')).toBeVisible();

    // Change the app-global selection the way a tap in pane A does (ais.highlight). Driven
    // through the app's own store module (same Vite module instance the panes import), not
    // a canvas tap: pane B never sees the tap either way, which is the whole point, and
    // deck.gl picking returns no hits under headless SwiftShader here (s1/s2 fail the same way).
    const highlight = async (id: string): Promise<void> => {
      const selected = await page.evaluate(async (vesselId) => {
        const url = '/src/stores/ais.svelte.ts';
        const { ais } = (await import(url)) as { ais: { highlight(id: string): void; selectedId: string | null } };
        ais.highlight(vesselId);
        return ais.selectedId;
      }, id);
      expect(selected).toBe(id);
    };

    // Let both vessels reach the AIS snapshot before selecting.
    await page.waitForTimeout(3000);
    await highlight(Y_ID);
    // Let pane B's live-extension effect pick up Y (throttled to one append per 5 s).
    await page.waitForTimeout(6500);

    await highlight(X_ID);
    // Past the 5 s throttle: on the unfixed code pane B appends X's position to Y's track.
    await page.waitForTimeout(7500);

    // Gap between Y and X in pane B, clear of both icons and labels.
    const left = await panePoint(page, '#pane-second', lonLatAtPx(VIEW, -90, 120).lon, y.lat);
    const right = await panePoint(page, '#pane-second', lonLatAtPx(VIEW, 90, 120).lon, x.lat);
    const count = await magentaPixels(page, left.x, left.y - 12, right.x - left.x, 24);
    expect(count, 'track pixels between Y and X in pane B').toBe(0);
  } finally {
    await mock.stop();
  }
});
