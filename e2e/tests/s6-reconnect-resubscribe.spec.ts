/**
 * S6 — a reconnected client must subscribe on the NEW socket.
 *
 * The stream URL only carries `?subscribe=self`; AIS targets (`vessels.*`)
 * flow only after the client's explicit subscribe message. Every recovery
 * path — server drop, tab return while offline, server switch — reuses the
 * worker's SignalKClient via `reconnect()`, which swaps the WebSocket but
 * keeps the original `onopen` handler. If that handler sends through the
 * socket it was created with, the subscriptions go to the dead socket: the
 * app reports Connected and self data still flows, but AIS stops for the rest
 * of the session.
 *
 * Oracle: the mock records which subscribe contexts arrived on each accepted
 * connection.
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles } from '../lib/app';

const CONTEXTS = ['vessels.self', 'vessels.*'];
const GREEN = 'rgb(74, 222, 128)';

const settingsButton = (page: Page) => page.locator('button[title="Settings"]');

test('subscriptions are re-sent on the replacement socket after the server drops the stream', async ({ page }) => {
  const mock = new MockSignalK();
  const port = await mock.start();

  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);
    await page.goto('/');

    await mock.waitForSubscriptions(1, CONTEXTS);
    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 20_000 });

    mock.dropConnections();
    await expect(settingsButton(page)).not.toHaveCSS('color', GREEN, { timeout: 10_000 });

    // App backs off 2 s, then `connect` with a live client → client.reconnect().
    const second = await mock.waitForSubscriptions(2, CONTEXTS);
    expect(second.subscribedContexts.filter((c) => c === 'vessels.*')).toHaveLength(1);
    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 10_000 });
  } finally {
    await mock.stop();
  }
});

test('subscriptions reach the new server after a server switch', async ({ page }) => {
  const first = new MockSignalK();
  const second = new MockSignalK();
  const firstPort = await first.start();
  const secondPort = await second.start();

  try {
    await seedApp(page, { port: firstPort });
    await blockExternalTiles(page);
    await page.goto('/');

    await first.waitForSubscriptions(1, CONTEXTS);
    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 20_000 });

    // Settings opens on the Connection tab; Save applies the new URL → reconnect().
    await settingsButton(page).click();
    await page.locator('input[type="number"][max="65535"]').fill(String(secondPort));
    await page.getByRole('button', { name: 'Save & reconnect' }).click();

    await second.waitForSubscriptions(1, CONTEXTS);
    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 10_000 });
  } finally {
    await first.stop();
    await second.stop();
  }
});
