/**
 * S13 — renaming a waypoint must not move it.
 *
 * Map.svelte `showWaypointPopup` took the waypoint's position from the
 * `queryRenderedFeatures` hit. For a GeoJSON source MapLibre rebuilds that
 * geometry from the internal vector tile, whose coordinates geojson-vt rounded
 * to an 8192-unit grid per tile — so the popup's lat/lon is snapped to a grid
 * of 360/(8192·2^z) degrees. "Rename" PUTs that position back, silently
 * moving the waypoint on the server (tens of metres at zoom 6).
 *
 * INTENDED behaviour: Rename changes only the name; the PUT carries the
 * waypoint's stored server coordinates unchanged.
 */
import { test, expect } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, clickLonLat, type View } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const WAYPOINTS_PATH = '/signalk/v2/api/resources/waypoints';
const UUID = 'e2e00000-0000-4000-8000-0000000000c1';
// Deliberately off any tile grid.
const LON = 10.123456789;
const LAT = 59.987654321;
// Low zoom → coarse tile grid (≈ 0.0007° per step at z6).
const VIEW_Z6: View = { lon: LON, lat: LAT, zoom: 6 };

test('renaming a waypoint PUTs its stored position, not the tile-snapped one', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    const entry = {
      name: 'Exact',
      feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [LON, LAT] }, properties: { name: 'Exact' } },
    };
    sk.restRoutes.set(WAYPOINTS_PATH, { [UUID]: entry });
    sk.restRoutes.set(`${WAYPOINTS_PATH}/${UUID}`, entry);

    await seedApp(page, { port, view: VIEW_Z6 });
    // Rename needs a login; the mock 404s /auth/validate, so the stored token is kept.
    await page.addInitScript((serverBase) => {
      localStorage.setItem('sk-auth', JSON.stringify({ serverBase, token: 'e2e-token', username: 'e2e' }));
    }, `http://127.0.0.1:${String(port)}`);
    await blockExternalTiles(page);

    let putBody: unknown = null;
    await page.route(`**${WAYPOINTS_PATH}/${UUID}`, async (route) => {
      if (route.request().method() === 'PUT') {
        putBody = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.continue();
    });
    page.on('dialog', (d) => { void d.accept('Renamed'); });

    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });

    const renameBtn = page.locator('.maplibregl-popup .rename-waypoint-btn');
    await expect(async () => {
      await clickLonLat(page, VIEW_Z6, LON, LAT);
      await expect(renameBtn).toBeEnabled({ timeout: 1500 });
    }).toPass({ timeout: 30_000 });
    await renameBtn.click();

    await expect.poll(() => putBody).not.toBeNull();
    const body = putBody as { name: string; feature: { geometry: { coordinates: [number, number] } } };
    expect(body.name).toBe('Renamed');
    expect(body.feature.geometry.coordinates).toEqual([LON, LAT]);
  } finally {
    await sk.stop();
  }
});
