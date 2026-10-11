/**
 * S7 — server-supplied names are injected as HTML into map popups.
 *
 * Route and waypoint names come from Signal K resources, which any client
 * with write access (or anyone on the LAN when server security is off) can
 * set. Map.svelte interpolates them unescaped into MapLibre `Popup.setHTML`
 * (showWaypointPopup, showAllRoutesPopup, openUnifiedDisambigPopup), so a
 * name such as `<img src=x onerror=…>` becomes live markup and runs script
 * when the item is tapped — script that can read the bearer token from
 * localStorage.
 *
 * INTENDED behaviour: a name is data, not markup. The popup shows the name
 * verbatim as text; no element from the name reaches the DOM and no handler
 * in it runs.
 *
 * On unfixed main: each popup contains the injected <img>, its onerror sets
 * `window.__xss`, and the title text is not the literal name.
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, clickLonLat, lonLatAtPx, VIEW } from '../lib/app';

declare global {
  interface Window { __xss?: string[] }
}

const payload = (tag: string): string =>
  `"><img src=x onerror="(window.__xss = window.__xss || []).push('${tag}')">${tag}`;

const WAYPOINT_NAME = payload('waypoint');
const ROUTE_NAME = payload('route');
const OVERLAP_WAYPOINT_NAME = payload('overlap-waypoint');
const OVERLAP_ROUTE_NAME = payload('overlap-route');

// Lone waypoint, lone route, and a waypoint sitting on a second route (a tap
// there hits both → unified disambiguation popup).
const lonePoint = lonLatAtPx(VIEW, -200, -120);
const routeA = lonLatAtPx(VIEW, 80, -120);
const routeB = lonLatAtPx(VIEW, 320, -120);
const routeMid = lonLatAtPx(VIEW, 200, -120);
const overlapPoint = lonLatAtPx(VIEW, 0, 160);
const overlapA = lonLatAtPx(VIEW, -120, 160);
const overlapB = lonLatAtPx(VIEW, 120, 160);

async function startApp(page: Page, mock: MockSignalK): Promise<void> {
  const waypointEntry = (name: string, p: { lon: number; lat: number }) => ({
    name,
    feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: {} },
  });
  const routeEntry = (name: string, a: { lon: number; lat: number }, b: { lon: number; lat: number }) => ({
    name,
    description: '',
    feature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] }, properties: {} },
  });
  mock.restRoutes.set('/signalk/v2/api/resources/waypoints', {
    'e2e00000-0000-4000-8000-0000000000a1': waypointEntry(WAYPOINT_NAME, lonePoint),
    'e2e00000-0000-4000-8000-0000000000a2': waypointEntry(OVERLAP_WAYPOINT_NAME, overlapPoint),
  });
  mock.restRoutes.set('/signalk/v2/api/resources/routes', {
    'e2e00000-0000-4000-8000-0000000000b1': routeEntry(ROUTE_NAME, routeA, routeB),
    'e2e00000-0000-4000-8000-0000000000b2': routeEntry(OVERLAP_ROUTE_NAME, overlapA, overlapB),
  });

  await seedApp(page, { port: mock.port });
  await blockExternalTiles(page);
  await page.goto('/');
  // Connected = green settings gear (routes/waypoints load on connect).
  await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', 'rgb(74, 222, 128)', { timeout: 20_000 });
}

/** Click at (lon, lat) until a popup matching `selector` opens (resources render asynchronously). */
async function openPopupAt(page: Page, p: { lon: number; lat: number }, selector: string): Promise<void> {
  const popup = page.locator(`.maplibregl-popup ${selector}`);
  await expect(async () => {
    await clickLonLat(page, VIEW, p.lon, p.lat);
    await expect(popup.first()).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 30_000 });
}

/** No markup from a name reached the popup, and no injected handler ran. */
async function expectNoInjection(page: Page): Promise<void> {
  // Give an injected <img> time to fail loading and fire onerror.
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__xss ?? []), 'handlers injected via names').toEqual([]);
  await expect(page.locator('.maplibregl-popup img')).toHaveCount(0);
}

test('waypoint popup shows the waypoint name as text', async ({ page }) => {
  const mock = new MockSignalK();
  await mock.start();
  try {
    await startApp(page, mock);
    await openPopupAt(page, lonePoint, '.ais-popup-title');
    await expectNoInjection(page);
    await expect(page.locator('.maplibregl-popup .ais-popup-title')).toHaveText(WAYPOINT_NAME);
  } finally {
    await mock.stop();
  }
});

test('route popup shows the route name as text', async ({ page }) => {
  const mock = new MockSignalK();
  await mock.start();
  try {
    await startApp(page, mock);
    await openPopupAt(page, routeMid, '.ais-popup-title');
    await expectNoInjection(page);
    await expect(page.locator('.maplibregl-popup .ais-popup-title')).toHaveText(ROUTE_NAME);
  } finally {
    await mock.stop();
  }
});

test('disambiguation popup shows waypoint and route names as text', async ({ page }) => {
  const mock = new MockSignalK();
  await mock.start();
  try {
    await startApp(page, mock);
    await openPopupAt(page, overlapPoint, '.map-disambig-item');
    await expectNoInjection(page);
    const items = await page.locator('.maplibregl-popup .map-disambig-item').allTextContents();
    expect(items.sort()).toEqual([
      `Route \u2014 ${OVERLAP_ROUTE_NAME}`,
      `Waypoint \u2014 ${OVERLAP_WAYPOINT_NAME}`,
    ]);
  } finally {
    await mock.stop();
  }
});
