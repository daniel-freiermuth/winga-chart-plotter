/**
 * Shared helpers: point the app at the mock server, block external tile
 * hosts, and convert lon/lat to canvas pixels for real map clicks.
 *
 * The app has no test hooks — connection settings and the initial camera are
 * read from localStorage (stores/settings.svelte.ts, stores/mapView.svelte.ts),
 * so tests seed those keys before the first script runs.
 */
import { expect, type Page } from '@playwright/test';

export interface View {
  lon: number;
  lat: number;
  zoom: number;
}

/** Camera used by every scenario: Oslo fjord, mercator, north-up. */
export const VIEW: View = { lon: 10.75, lat: 59.9, zoom: 14 };

export async function seedApp(
  page: Page,
  opts: { port: number; view?: View; useGeoLocation?: boolean },
): Promise<void> {
  const view = opts.view ?? VIEW;
  await page.addInitScript(
    ({ port, view: v, geo }) => {
      localStorage.setItem('signalk-chart-settings', JSON.stringify({
        signalkProtocol: 'ws',
        signalkHost: '127.0.0.1',
        signalkPort: port,
        useGeoLocation: geo,
      }));
      localStorage.setItem('map-view-coords', JSON.stringify({
        center: [v.lon, v.lat],
        zoom: v.zoom,
        bearing: 0,
      }));
      localStorage.setItem('map-view-projection', 'mercator');
    },
    { port: opts.port, view, geo: opts.useGeoLocation ?? false },
  );
}

/** Abort requests to the external tile hosts in DEFAULT_STYLE — tests must not need internet. */
export async function blockExternalTiles(page: Page): Promise<void> {
  for (const host of ['tile.openstreetmap.org', 'tiles.openseamap.org', 'tiles.stadiamaps.com']) {
    await page.route(`https://${host}/**`, (route) => route.abort());
  }
}

// ── Signal K REST mock replies and route planner locators ───────────────────

export const ROUTES_PATH = '/signalk/v2/api/resources/routes';

/** Signal K v2 success reply for course/resource commands. */
export const COMPLETED = { status: 200, contentType: 'application/json', body: '{"state":"COMPLETED","statusCode":200}' };

/** Generic server error reply for a command the test wants rejected. */
export const MOCK_FAILURE = { status: 500, contentType: 'application/json', body: '{"message":"mock failure"}' };

export const routeNameInput = (page: Page) => page.getByPlaceholder('Route name…');
export const updateRouteButton = (page: Page) => page.locator('button[title="Update route"]');

/**
 * Open a route in the planner from the popup at `at`: retry the click until
 * the popup's `buttonClass` button is enabled, click it, and wait for the
 * planner to show `expectedName`. `.edit-active-route-btn` is the active
 * route's waypoint popup; `.edit-route-btn` the all-routes popup on a line.
 */
export async function openRouteEditor(
  page: Page,
  at: { lon: number; lat: number },
  expectedName: string,
  buttonClass = '.edit-active-route-btn',
): Promise<void> {
  const button = page.locator(`.maplibregl-popup ${buttonClass}`);
  await expect(async () => {
    await page.keyboard.press('Escape');
    await clickLonLat(page, VIEW, at.lon, at.lat);
    await expect(button).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await button.click();
  await expect(routeNameInput(page)).toHaveValue(expectedName);
}

// ── Web-mercator pixel math ──────────────────────────────────────────────────
// MapLibre's transform: world is 512 * 2^zoom CSS px wide; bearing 0, pitch 0.

const worldSize = (zoom: number): number => 512 * Math.pow(2, zoom);

function mercatorPx(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const ws = worldSize(zoom);
  const x = ((lon + 180) / 360) * ws;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * ws;
  return { x, y };
}

/** Pixel offset of (lon, lat) from the view centre at the view's zoom. */
export function pxOffset(view: View, lon: number, lat: number): { dx: number; dy: number } {
  const c = mercatorPx(view.lon, view.lat, view.zoom);
  const p = mercatorPx(lon, lat, view.zoom);
  return { dx: p.x - c.x, dy: p.y - c.y };
}

/** Inverse of pxOffset: lon/lat that sits `dx`,`dy` CSS px from the view centre. */
export function lonLatAtPx(view: View, dx: number, dy: number): { lon: number; lat: number } {
  const ws = worldSize(view.zoom);
  const c = mercatorPx(view.lon, view.lat, view.zoom);
  const lon = ((c.x + dx) / ws) * 360 - 180;
  const yNorm = 1 - (2 * (c.y + dy)) / ws;
  const lat = (Math.atan(Math.sinh(yNorm * Math.PI)) * 180) / Math.PI;
  return { lon, lat };
}

/** Viewport (page) coordinates of a lon/lat, assuming the camera still sits at `view`. */
export async function pagePoint(page: Page, view: View, lon: number, lat: number): Promise<{ x: number; y: number }> {
  const canvas = page.locator('.maplibregl-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('map canvas not laid out');
  const { dx, dy } = pxOffset(view, lon, lat);
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}

/** Real canvas click at a lon/lat (drives MapLibre's click → deck.gl picking). */
export async function clickLonLat(page: Page, view: View, lon: number, lat: number): Promise<void> {
  const { x, y } = await pagePoint(page, view, lon, lat);
  await page.mouse.click(x, y);
}

/**
 * Replace navigator.geolocation with a scripted 1 Hz watch that reports
 * heading/speed (Playwright's setGeolocation can't set those) and advances
 * the position each tick — used by the own-state staleness scenario.
 */
export async function stubGeolocation(
  page: Page,
  opts: {
    lon: number;
    lat: number;
    /** degrees true — becomes vessel.cog */
    headingDeg: number;
    /** m/s — becomes vessel.sog */
    speedMs: number;
    /** northward drift applied to the reported fix, m/s */
    driftNorthMs: number;
  },
): Promise<void> {
  await page.addInitScript((o) => {
    let tick = 0;
    const mkPos = () => ({
      coords: {
        longitude: o.lon,
        latitude: o.lat + (tick * o.driftNorthMs) / 111_320,
        accuracy: 3,
        altitude: null,
        altitudeAccuracy: null,
        heading: o.headingDeg,
        speed: o.speedMs,
      },
      timestamp: Date.now(),
    });
    const geo = {
      getCurrentPosition(ok: (p: unknown) => void) { ok(mkPos()); },
      watchPosition(ok: (p: unknown) => void): number {
        ok(mkPos());
        return window.setInterval(() => { tick += 1; ok(mkPos()); }, 1000);
      },
      clearWatch(id: number) { window.clearInterval(id); },
    };
    Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
  }, opts);
}
