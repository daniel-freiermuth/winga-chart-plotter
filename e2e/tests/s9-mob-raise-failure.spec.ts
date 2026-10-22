/**
 * S9 — a failed Man Overboard raise must be visible to the crew.
 *
 * App.svelte `mobRaise` POSTs /signalk/v2/api/notifications/mob through
 * `raiseMob`, which rejects on any non-2xx response or network failure. The
 * rejection used to go to console.error only: on a server without the v2
 * Notifications API (404), with a rejected token (401/403) or while offline,
 * tapping MOB changed nothing on screen, so the crew would assume the alarm
 * was raised.
 *
 * INTENDED behaviour: a failed raise shows an alert next to the MOB button;
 * a later raise that succeeds clears it.
 *
 * The mock server answers every unrouted request with 404, i.e. it behaves
 * like a Signal K server without the v2 Notifications API.
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const MOB_PATH = '/signalk/v2/api/notifications/mob';

const settingsButton = (page: Page) => page.locator('button[title="Settings"]');
const mobButton = (page: Page) => page.locator('.mob-btn');
const mobAlert = (page: Page) => page.locator('.mob-container').getByRole('alert');

test('a rejected MOB raise is shown next to the MOB button', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);
    await page.goto('/');
    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 20_000 });

    await expect(mobAlert(page)).toHaveCount(0);
    await mobButton(page).click();

    await expect.poll(() => sk.requests.some((r) => r.url === MOB_PATH)).toBe(true);
    await expect(mobAlert(page)).toBeVisible({ timeout: 5_000 });
  } finally {
    await sk.stop();
  }
});

test('a successful MOB raise clears the previous failure', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);
    await page.goto('/');
    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 20_000 });

    await mobButton(page).click();
    await expect(mobAlert(page)).toBeVisible({ timeout: 5_000 });

    // The server now accepts the raise.
    let raised = false;
    await page.route(`**${MOB_PATH}`, async (route) => {
      if (route.request().method() === 'POST') raised = true;
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'POST',
        },
        contentType: 'application/json',
        body: '{"state":"COMPLETED","statusCode":200}',
      });
    });
    await mobButton(page).click();

    await expect.poll(() => raised).toBe(true);
    await expect(mobAlert(page)).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await sk.stop();
  }
});
