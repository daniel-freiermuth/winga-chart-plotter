/**
 * S8 — switching to another Signal K server must drop the old server's
 * own-ship state.
 *
 * On a server switch the worker reuses its SignalKClient; the new Hello names
 * a different self, so Storage discards the old vessels. The client only emits
 * own-vessel state once it has a position, so a server without an own fix
 * (GPS not fixed yet, shore/planning server) never sends anything that would
 * overwrite the main thread's `vesselState`. Unless the app clears it on the
 * switch, server A's last fix keeps being shown as live own-ship data — and
 * feeds follow mode, CPA and the new server's track.
 *
 * Oracle: the follow button is enabled only while `vesselState.position` is
 * set (Map.svelte `disabled={!following && !position}`).
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK, OWN_ID } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, VIEW } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const OTHER_SELF = 'urn:mrn:signalk:uuid:e2e00000-0000-4000-8000-0000000000b2';

const settingsButton = (page: Page) => page.locator('button[title="Settings"]');

test('own-ship position from the previous server is dropped after a server switch', async ({ page }) => {
  const first = new MockSignalK(OWN_ID);
  const second = new MockSignalK(OTHER_SELF);
  const firstPort = await first.start();
  const secondPort = await second.start();

  try {
    await seedApp(page, { port: firstPort });
    await blockExternalTiles(page);
    // Pane chrome: compass (0) → follow pin (1) → layers.
    const followBtn = page.locator('.nav-stack button.nav-fab').nth(1);
    await page.goto('/');

    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 20_000 });
    first.every(500, () => first.ownNav({ lon: VIEW.lon, lat: VIEW.lat, cogRad: 0.5, sogMs: 3 }));
    await expect(followBtn).toBeEnabled({ timeout: 10_000 });

    // Server B announces a different self and never reports an own position.
    await settingsButton(page).click();
    await page.locator('input[type="number"][max="65535"]').fill(String(secondPort));
    await page.getByRole('button', { name: 'Save & reconnect' }).click();

    await second.waitForSubscriptions(1, ['vessels.self']);
    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 10_000 });

    await expect(followBtn).toBeDisabled({ timeout: 5_000 });
  } finally {
    await first.stop();
    await second.stop();
  }
});

// The same vessel behind another URL: Storage keeps its data, so every own
// state on the new socket equals the last one emitted before the switch. It
// must still reach the app, which cleared its own-ship state on the switch.
test('an unchanged own-ship fix reappears after switching to the same vessel', async ({ page }) => {
  const first = new MockSignalK(OWN_ID);
  const second = new MockSignalK(OWN_ID);
  const firstPort = await first.start();
  const secondPort = await second.start();
  const fix = { lon: VIEW.lon, lat: VIEW.lat, cogRad: 0.5, sogMs: 3 };

  try {
    await seedApp(page, { port: firstPort });
    await blockExternalTiles(page);
    const followBtn = page.locator('.nav-stack button.nav-fab').nth(1);
    await page.goto('/');

    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 20_000 });
    first.ownNav(fix);
    await expect(followBtn).toBeEnabled({ timeout: 10_000 });

    await settingsButton(page).click();
    await page.locator('input[type="number"][max="65535"]').fill(String(secondPort));
    await page.getByRole('button', { name: 'Save & reconnect' }).click();

    await second.waitForSubscriptions(1, ['vessels.self']);
    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 10_000 });
    second.ownNav(fix);
    await expect(followBtn).toBeEnabled({ timeout: 5_000 });
  } finally {
    await first.stop();
    await second.stop();
  }
});
