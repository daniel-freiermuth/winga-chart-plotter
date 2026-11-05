/**
 * S11 — a still touch hold on a route-planner handle must not delete the waypoint.
 *
 * Touch long-press is owned by the app's own timer in Map.svelte, which skips
 * drag handles ("drag handles start a drag, not a long-press"). maplibre-gl
 * 6.11+ additionally fires a synthetic map `contextmenu` after any 500 ms
 * single-finger hold; routed through `map.on('contextmenu')` that reaches the
 * planner handle's `onContextMenu` → `routePlanner.removeWaypoint(idx)`, so the
 * usual press-pause-drag on a tablet silently deleted the held waypoint.
 *
 * Real touch input (CDP Input.dispatchTouchEvent) is required: it produces the
 * TouchEvents MapLibre's handlers listen to, plus the PointerEvents the app's
 * drag recognizer listens to.
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, pagePoint, VIEW } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';

test.use({ hasTouch: true });

async function touchHold(page: Page, x: number, y: number, ms: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('holding a planner handle still on touch keeps the waypoint', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);
    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });

    // Plan a 2-point route with the mouse: right-click → "Start route from here", click a second point.
    const start = await pagePoint(page, VIEW, VIEW.lon - 0.005, VIEW.lat);
    await page.mouse.click(start.x, start.y, { button: 'right' });
    await page.locator('.maplibregl-popup .route-here-btn').click();
    const end = await pagePoint(page, VIEW, VIEW.lon + 0.005, VIEW.lat);
    await page.mouse.click(end.x, end.y);
    await expect(page.getByText('2 waypoints')).toBeVisible();

    // Press-and-pause on the first handle, well past the 500 ms long-press delay.
    await touchHold(page, start.x, start.y, 1_000);

    // The hold is a drag that never moved — it must not remove the waypoint.
    await expect(page.getByText('2 waypoints')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByText('2 waypoints')).toBeVisible();
  } finally {
    await sk.stop();
  }
});
