/**
 * S12 — a mouse right-click must open the map context menu regardless of touch history.
 *
 * `TouchEvent.touches` is document-wide, so when the last map finger lifts while
 * another finger still rests outside MapLibre's canvas container (a control, a side
 * panel), the map `touchend` still reports a touch and Map.svelte's `_touchActive`
 * stays true; the other finger's lift never reaches the map. The map `contextmenu`
 * handler must not key off that flag — on hybrid touch+mouse devices it would drop
 * every later right-click (no navigate popup, no "Start route from here").
 */
import { test, expect } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, pagePoint, VIEW } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';

test.use({ hasTouch: true });

test('right-click opens the navigate popup after a touch that ended off the map', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);
    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });

    // Second finger rests on the scale bar: a control outside the canvas container,
    // so MapLibre never sees its touch events.
    const scale = await page.locator('.maplibregl-ctrl-scale').boundingBox();
    if (!scale) throw new Error('scale control not laid out');
    const off = { x: scale.x + scale.width / 2, y: scale.y + scale.height / 2, id: 2 };
    const on = { ...(await pagePoint(page, VIEW, VIEW.lon + 0.004, VIEW.lat + 0.002)), id: 1 };

    // Chromium's CDP touchEnd releases the points it lists. Observed event sequence:
    // map touchend with touches=1, then the scale-bar touchend (never seen by the map).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [off] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [off, on] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [on] }); // map finger lifts first
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await page.waitForTimeout(300);

    // Later: a plain mouse right-click on open water.
    const pt = await pagePoint(page, VIEW, VIEW.lon - 0.005, VIEW.lat);
    await page.mouse.click(pt.x, pt.y, { button: 'right' });
    await expect(page.locator('.maplibregl-popup .route-here-btn')).toBeVisible();
  } finally {
    await sk.stop();
  }
});
