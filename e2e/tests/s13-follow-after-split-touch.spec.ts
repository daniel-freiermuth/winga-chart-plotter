/**
 * S13 — follow mode keeps tracking own ship after a split touch.
 *
 * `TouchEvent.touches` is document-wide, so when the map finger lifts while
 * another finger still rests outside MapLibre's canvas container (a control, a
 * side panel), the map `touchend` still reports a touch, and the other finger's
 * lift never reaches the map. Map.svelte's `_touchActive` (set on map touchstart)
 * must not survive that: it gates every follow easeTo, so a stuck flag freezes
 * the camera while own ship sails off screen until the map is touched again.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, pagePoint, VIEW } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';

test.use({ hasTouch: true });

async function cameraCenter(page: Page): Promise<[number, number]> {
  const raw = await page.evaluate(() => localStorage.getItem('map-view-coords'));
  if (!raw) throw new Error('map-view-coords not persisted yet');
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || !('center' in parsed) || !Array.isArray(parsed.center)) {
    throw new Error('map-view-coords: unexpected shape');
  }
  const [lon, lat]: unknown[] = parsed.center;
  if (typeof lon !== 'number' || typeof lat !== 'number') throw new Error('map-view-coords: bad center');
  return [lon, lat];
}

test('follow keeps tracking own vessel after a touch whose last finger lifted off the map', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);
    // Follow on, vessel pinned to the view centre.
    await page.addInitScript(() => {
      localStorage.setItem('follow-mode-offset', JSON.stringify({ left: 0, top: 0 }));
    });
    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });

    // Pane chrome: compass (0) → follow pin (1) → layers.
    const followBtn = page.locator('.nav-stack button.nav-fab').nth(1);
    sk.ownNav({ lon: VIEW.lon, lat: VIEW.lat, cogRad: 0, sogMs: 0 });
    await expect(followBtn).toHaveAttribute('title', 'Stop following vessel');

    // Second finger rests on the scale bar: a control outside the canvas container,
    // so MapLibre never sees its touch events. Same sequence as S12.
    const scale = await page.locator('.maplibregl-ctrl-scale').boundingBox();
    if (!scale) throw new Error('scale control not laid out');
    const off = { x: scale.x + scale.width / 2, y: scale.y + scale.height / 2, id: 2 };
    const on = { ...(await pagePoint(page, VIEW, VIEW.lon + 0.004, VIEW.lat + 0.002)), id: 1 };

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [off] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [off, on] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [on] }); // map finger lifts first
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await page.waitForTimeout(300);

    // No finger is on the screen any more: own ship moves and the camera must follow.
    const moved = { lon: VIEW.lon + 0.01, lat: VIEW.lat + 0.005 };
    sk.ownNav({ lon: moved.lon, lat: moved.lat, cogRad: 0, sogMs: 0 });
    await expect.poll(async () => {
      const [lon, lat] = await cameraCenter(page);
      return Math.hypot(lon - moved.lon, lat - moved.lat);
    }, { timeout: 5_000 }).toBeLessThan(1e-4);
  } finally {
    await sk.stop();
  }
});
