/**
 * S13 — a failed course/resource command sent from a map popup must be visible.
 *
 * Map.svelte's popup handlers ('Navigate here', 'Clear course', 'Activate
 * route', 'Set as next waypoint', waypoint add/move/rename/delete, route
 * delete) close the popup and fire the Signal K REST call. The Rust side
 * rejects on any non-2xx or network failure, but the rejection went to
 * console.error only: with a rejected token (401/403), a server without the
 * v2 Course API (404), a 5xx or while offline the popup closed and nothing
 * on screen said the command had not taken effect.
 *
 * INTENDED behaviour (same contract as the MOB raise in S9): a rejected
 * command shows an app-wide alert naming the command; a later success on the
 * same target (course, or one waypoint/route), from either pane, clears it.
 *
 * The mock server answers every unrouted request with 404, i.e. it behaves
 * like a Signal K server without the v2 Course / Resources write API.
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, pagePoint, clickLonLat, lonLatAtPx, VIEW } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const DESTINATION_PATH = '/signalk/v2/api/vessels/self/navigation/course/destination';

// Rendered once for the whole app, whichever pane sent the command.
const commandAlert = (page: Page) => page.locator('.map-command-errors').getByRole('alert');

async function bootLoggedIn(page: Page, port: number, opts: { split?: boolean } = {}): Promise<void> {
  await seedApp(page, { port });
  if (opts.split) {
    await page.addInitScript(() => {
      const s = JSON.parse(localStorage.getItem('signalk-chart-settings') ?? '{}') as Record<string, unknown>;
      localStorage.setItem('signalk-chart-settings', JSON.stringify({ ...s, paneLayout: 'split' }));
    });
  }
  // Commands need a login; the mock 404s /auth/validate, so the stored token is kept.
  await page.addInitScript((serverBase) => {
    localStorage.setItem('sk-auth', JSON.stringify({ serverBase, token: 'e2e-token', username: 'e2e' }));
  }, `http://127.0.0.1:${String(port)}`);
  await blockExternalTiles(page);
  await page.goto('/');
  await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });
}

async function openWaterPopup(page: Page): Promise<void> {
  const p = await pagePoint(page, VIEW, VIEW.lon + 0.003, VIEW.lat);
  await page.mouse.click(p.x, p.y, { button: 'right' });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE',
};

/** Click at (lon, lat) until a popup matching `selector` opens (resources render asynchronously). */
async function openPopupAt(page: Page, p: { lon: number; lat: number }, selector: string): Promise<void> {
  const popup = page.locator(`.maplibregl-popup ${selector}`);
  await expect(async () => {
    await clickLonLat(page, VIEW, p.lon, p.lat);
    await expect(popup.first()).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 30_000 });
}

test('a rejected "Navigate here" is shown on the map', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await bootLoggedIn(page, port);
    await expect(commandAlert(page)).toHaveCount(0);

    await openWaterPopup(page);
    await page.locator('.maplibregl-popup .navigate-here-btn').click();

    await expect.poll(() => sk.requests.some((r) => r.url === DESTINATION_PATH)).toBe(true);
    await expect(commandAlert(page)).toBeVisible({ timeout: 5_000 });
    await expect(commandAlert(page)).toContainText('Navigate here');
  } finally {
    await sk.stop();
  }
});

test('a later successful "Navigate here" clears the previous failure', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await bootLoggedIn(page, port);

    await openWaterPopup(page);
    await page.locator('.maplibregl-popup .navigate-here-btn').click();
    await expect(commandAlert(page)).toBeVisible({ timeout: 5_000 });

    // The server now accepts the course.
    let accepted = false;
    await page.route(`**${DESTINATION_PATH}`, async (route) => {
      const method = route.request().method();
      if (method === 'PUT') accepted = true;
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'PUT',
        },
        contentType: 'application/json',
        body: '{"state":"COMPLETED","statusCode":200}',
      });
    });
    await openWaterPopup(page);
    await page.locator('.maplibregl-popup .navigate-here-btn').click();

    await expect.poll(() => accepted).toBe(true);
    await expect(commandAlert(page)).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await sk.stop();
  }
});

test('a rejected "Add waypoint here" is shown on the map', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await bootLoggedIn(page, port);

    page.once('dialog', (d) => { void d.accept('E2E waypoint'); });
    await openWaterPopup(page);
    await page.locator('.maplibregl-popup .add-waypoint-here-btn').click();

    await expect(commandAlert(page)).toBeVisible({ timeout: 5_000 });
    await expect(commandAlert(page)).toContainText('Add waypoint');
  } finally {
    await sk.stop();
  }
});

test('a slow failure of an earlier command is not hidden by a later, different failure', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await bootLoggedIn(page, port);

    // 'Add waypoint' is held in flight; it fails only after 'Navigate here' has failed.
    let releaseSave: (() => Promise<void>) | null = null;
    await page.route('**/signalk/v2/api/resources/waypoints', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (route.request().method() !== 'POST') return route.continue();
      releaseSave = () => route.fulfill({ status: 500, headers: CORS, body: 'boom' });
    });
    page.once('dialog', (d) => { void d.accept('E2E waypoint'); });
    await openWaterPopup(page);
    await page.locator('.maplibregl-popup .add-waypoint-here-btn').click();
    await expect.poll(() => releaseSave !== null).toBe(true);

    await openWaterPopup(page);
    await page.locator('.maplibregl-popup .navigate-here-btn').click();
    await expect(commandAlert(page)).toContainText('Navigate here', { timeout: 5_000 });

    await releaseSave!();
    await expect(commandAlert(page).filter({ hasText: 'Add waypoint' })).toBeVisible({ timeout: 5_000 });
    await expect(commandAlert(page).filter({ hasText: 'Navigate here' })).toBeVisible();
  } finally {
    await sk.stop();
  }
});

test('a success on one waypoint does not hide a failure on another', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  const failing = { uuid: 'e2e00000-0000-4000-8000-0000000000c1', ...lonLatAtPx(VIEW, -200, -120) };
  const working = { uuid: 'e2e00000-0000-4000-8000-0000000000c2', ...lonLatAtPx(VIEW, 200, -120) };
  const entry = (name: string, p: { lon: number; lat: number }) => ({
    name,
    feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: {} },
  });
  sk.restRoutes.set('/signalk/v2/api/resources/waypoints', {
    [failing.uuid]: entry('Failing', failing),
    [working.uuid]: entry('Working', working),
  });
  try {
    await bootLoggedIn(page, port);

    // DELETE of `failing` gets the mock's 404; DELETE of `working` is accepted.
    let deleted = false;
    await page.route(`**/signalk/v2/api/resources/waypoints/${working.uuid}`, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      if (route.request().method() !== 'DELETE') return route.continue();
      deleted = true;
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{}' });
    });
    page.on('dialog', (d) => { void d.accept(); });

    await openPopupAt(page, failing, '.delete-waypoint-btn');
    await page.locator('.maplibregl-popup .delete-waypoint-btn').click();
    await expect(commandAlert(page)).toContainText('Delete waypoint', { timeout: 5_000 });

    const reloadsBefore = sk.requests.filter((r) => r.method === 'GET' && r.url === '/signalk/v2/api/resources/waypoints').length;
    await openPopupAt(page, working, '.delete-waypoint-btn');
    await page.locator('.maplibregl-popup .delete-waypoint-btn').click();
    await expect.poll(() => deleted).toBe(true);
    // The success settles after the follow-up waypoint reload.
    await expect.poll(() => sk.requests.filter((r) => r.method === 'GET' && r.url === '/signalk/v2/api/resources/waypoints').length)
      .toBeGreaterThan(reloadsBefore);
    await page.waitForTimeout(500);
    await expect(commandAlert(page)).toContainText('Delete waypoint');
  } finally {
    await sk.stop();
  }
});

test('a failure in one pane is cleared by the same target succeeding in the other pane', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await bootLoggedIn(page, port, { split: true });

    // Right-click open water in a given pane: both panes talk to the same server.
    const rightClickPane = async (paneId: string) => {
      const box = await page.locator(`#${paneId} .maplibregl-canvas`).boundingBox();
      if (!box) throw new Error(`${paneId} canvas not laid out`);
      await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2, { button: 'right' });
      await page.locator(`#${paneId} .maplibregl-popup .navigate-here-btn`).click();
    };

    await rightClickPane('pane-primary');
    await expect(commandAlert(page)).toContainText('Navigate here', { timeout: 5_000 });

    // The server now accepts the course; the retry happens in the other pane.
    let accepted = false;
    await page.route(`**${DESTINATION_PATH}`, async (route) => {
      if (route.request().method() === 'PUT') accepted = true;
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{}' });
    });
    await rightClickPane('pane-second');
    await expect.poll(() => accepted).toBe(true);

    // The course is now set on the server: no pane may still claim it failed.
    await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await sk.stop();
  }
});
