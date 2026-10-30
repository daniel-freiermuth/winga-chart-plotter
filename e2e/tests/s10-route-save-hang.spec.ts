/**
 * S10 — a route save the server never answers must not lock the planner.
 *
 * App.svelte `handleSaveRoute` sets `plannerSaving` (Save disabled, label
 * '…') and only clears it once `saveRoute`/`updateRoute` settle. Those
 * requests carried no timeout, so against a half-up host or a black-holed
 * route the promise never settled: Save stayed '…' and disabled with no
 * error shown, and the crew's only way out was Discard — losing the route.
 *
 * INTENDED behaviour (same contract as the MOB raise in S9): a hung request
 * times out into a rejection, the planner shows the error and Save is
 * usable again with the planned route intact.
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, pagePoint, VIEW } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const ROUTES_PATH = '/signalk/v2/api/resources/routes';

const saveButton = (page: Page) => page.locator('button[title="Save as route"]');

test('a route save the server never answers times out into an error and re-enables Save', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await seedApp(page, { port });
    // Saving needs a login; the mock 404s /auth/validate, so the stored token is kept.
    await page.addInitScript((serverBase) => {
      localStorage.setItem('sk-auth', JSON.stringify({ serverBase, token: 'e2e-token', username: 'e2e' }));
    }, `http://127.0.0.1:${String(port)}`);
    await blockExternalTiles(page);
    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });

    // Half-up server / black-holed route: the POST is accepted but never answered.
    let posted = false;
    await page.route(`**${ROUTES_PATH}`, async (route) => {
      if (route.request().method() === 'POST') {
        posted = true;
        return; // Never fulfilled, aborted or continued.
      }
      await route.continue();
    });

    // Plan a 2-point route: right-click → "Start route from here", then click a second point.
    const start = await pagePoint(page, VIEW, VIEW.lon - 0.005, VIEW.lat);
    await page.mouse.click(start.x, start.y, { button: 'right' });
    await page.locator('.maplibregl-popup .route-here-btn').click();
    const end = await pagePoint(page, VIEW, VIEW.lon + 0.005, VIEW.lat);
    await page.mouse.click(end.x, end.y);

    await page.getByPlaceholder('Route name…').fill('E2E hung save');
    await expect(saveButton(page)).toBeEnabled();
    await saveButton(page).click();
    await expect.poll(() => posted).toBe(true);
    await expect(saveButton(page)).toHaveText('…');

    // The hung save must not stay pending forever: it times out into an error
    // and the crew can retry without losing the planned route.
    await expect(saveButton(page)).toHaveText('Save', { timeout: 20_000 });
    await expect(saveButton(page)).toBeEnabled();
    await expect(page.getByText(/Save route failed/)).toBeVisible();
    await expect(page.getByPlaceholder('Route name…')).toHaveValue('E2E hung save');
  } finally {
    await sk.stop();
  }
});
