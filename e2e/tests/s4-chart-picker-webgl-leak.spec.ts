/**
 * S4 — chart-picker WebGL-context leak (LazyMapThumb never re-hides).
 *
 * The picker mounts one preview map per card; LazyMapThumb reveals a card the
 * first time it intersects the viewport and then never unmounts it, so every
 * revealed card keeps a live maplibregl.Map — one WebGL context each.  A
 * server exposing many charts (or WMTS layers, which are flattened to one
 * card per layer) exceeds the browser's ~16-context cap; the browser then
 * evicts the OLDEST context, which is the main chart map created at startup.
 *
 * INTENDED behaviour: browsing the chart picker must never kill the main
 * map's WebGL context, no matter how many cards are scrolled past.
 *
 * On unfixed main: scrolling through 20 chart cards logs "Too many active
 * WebGL contexts. Oldest context will be lost." and the main map canvas
 * fires `webglcontextlost` (this test's final expectation fails).
 */
import { test, expect } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles } from '../lib/app';

const CHART_COUNT = 20;

declare global {
  interface Window { __mainMapContextLost?: boolean }
}

test('main map survives scrolling through a large chart picker', async ({ page }) => {
  const mock = new MockSignalK();
  const port = await mock.start();

  try {
    // 20 raster tile charts — one picker card each, tiles answered 404 by the
    // mock (MapLibre creates the WebGL context regardless of tile errors).
    const charts: Record<string, unknown> = {};
    for (let i = 1; i <= CHART_COUNT; i++) {
      const id = `chart-${String(i).padStart(2, '0')}`;
      charts[id] = {
        identifier: id,
        name:       `Chart ${i}`,
        url:        `/charts/${id}/{z}/{x}/{y}.png`,
        format:     'png',
        type:       'tilelayer',
        minzoom:    1,
        maxzoom:    18,
      };
    }
    mock.restRoutes.set('/signalk/v2/api/resources/charts', charts);

    await seedApp(page, { port });
    await blockExternalTiles(page);
    await page.goto('/');

    // Connected = green settings gear (guarantees charts.load() has fired).
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', 'rgb(74, 222, 128)', { timeout: 20_000 });

    // The only maplibre canvas before the picker opens is the main map's.
    await page.waitForSelector('canvas.maplibregl-canvas');
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas.maplibregl-canvas');
      if (!canvas) throw new Error('main map canvas not found');
      window.__mainMapContextLost = false;
      canvas.addEventListener('webglcontextlost', () => { window.__mainMapContextLost = true; });
    });

    // Open the chart picker and wait for the card grid.
    await page.locator('button[title="Charts & layers"]').click();
    const grid = page.locator('.grid');
    await expect(grid.locator('.card')).toHaveCount(CHART_COUNT + 2, { timeout: 15_000 }); // + 2 base layers

    // Scroll the sheet through every card so each one intersects the viewport.
    await page.evaluate(async () => {
      const scroller = document.querySelector('.sheet-scroll');
      if (!(scroller instanceof HTMLElement)) throw new Error('sheet scroller not found');
      for (let y = 0; y <= scroller.scrollHeight; y += 150) {
        scroller.scrollTop = y;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 100);
        await promise;
      }
    });

    // Give the browser time to create the trailing preview contexts (and, on
    // unfixed main, to evict the oldest ones).
    await page.waitForTimeout(4000);

    // INTENDED behaviour: the main map's WebGL context is still alive.
    // Unfixed main: the context cap evicted it → __mainMapContextLost is true.
    expect(await page.evaluate(() => window.__mainMapContextLost)).toBe(false);
  } finally {
    await mock.stop();
  }
});
