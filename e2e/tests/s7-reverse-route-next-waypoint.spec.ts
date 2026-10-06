/**
 * S7 — active route followed in reverse: next-waypoint frame.
 *
 * Signal K's activeRoute.pointIndex counts along the direction of travel:
 * with reverse=true, pointIndex 0 is the LAST coordinate of the route geometry
 * (signalk-server getRoutePoint: coordinates[length - (index + 1)]). The
 * active-route popup must compare the clicked waypoint's forward geometry
 * index against that mirrored index.
 *
 * Observable via the "Set as next waypoint" button: it is disabled with
 * "Already the next waypoint" only on the current next point; any other
 * waypoint (logged out) is disabled with "Login required". Treating pointIndex
 * as a forward index marks the FIRST geometry point as next instead.
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK, OWN_ID } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, clickLonLat, lonLatAtPx, VIEW } from '../lib/app';

const ROUTE_UUID = 'e2e00000-0000-4000-8000-000000000007';

test('reverse-followed route: popup marks the last geometry point as next', async ({ page }) => {
  const mock = new MockSignalK();
  const port = await mock.start();

  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);

    // Waypoints well clear of the own vessel (view centre) and of each other.
    const first = lonLatAtPx(VIEW, -200, -120);
    const mid   = lonLatAtPx(VIEW, 0, -120);
    const last  = lonLatAtPx(VIEW, 200, -120);
    mock.restRoutes.set(`/signalk/v2/api/resources/routes/${ROUTE_UUID}`, {
      name: 'E2E reverse',
      feature: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[first.lon, first.lat], [mid.lon, mid.lat], [last.lon, last.lat]] },
        properties: {},
      },
    });

    await page.goto('/');
    mock.every(1000, () => {
      // Own vessel exactly at the view centre: the first fix triggers an
      // auto-flyTo, any other spot would move the camera.
      mock.ownNav({ lon: VIEW.lon, lat: VIEW.lat, cogRad: Math.PI / 2, sogMs: 3 });
      mock.delta(OWN_ID, [
        { path: 'navigation.course.nextPoint', value: { position: { longitude: last.lon, latitude: last.lat } } },
        { path: 'navigation.course.activeRoute', value: {
          href: `/resources/routes/${ROUTE_UUID}`, name: 'E2E reverse', pointIndex: 0, reverse: true,
        } },
      ]);
    });

    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', 'rgb(74, 222, 128)', { timeout: 20_000 });

    // pointIndex 0 in reverse → the last geometry point is the next waypoint.
    await expect(async () => {
      expect(await setNextTitleAt(page, last)).toBe('Already the next waypoint');
    }).toPass({ timeout: 30_000 });

    // The first geometry point is the far end of the route in reverse.
    expect(await setNextTitleAt(page, first)).toBe('Login required');
  } finally {
    await mock.stop();
  }
});

/** Click a route waypoint and return the "Set as next waypoint" button's tooltip. */
async function setNextTitleAt(page: Page, at: { lon: number; lat: number }): Promise<string | null> {
  await page.keyboard.press('Escape');
  await clickLonLat(page, VIEW, at.lon, at.lat);
  const btn = page.locator('.maplibregl-popup .set-next-wpt-btn');
  await expect(btn).toBeVisible({ timeout: 2000 });
  return btn.getAttribute('title');
}
