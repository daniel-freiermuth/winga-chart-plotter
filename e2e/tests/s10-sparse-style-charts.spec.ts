/**
 * S10 — schema-valid Signal K style/TileJSON charts without a vendor `style`.
 *
 * Signal K's ChartSchema carries a mapstyleJSON chart's style document (and a
 * tileJSON chart's TileJSON document) in `url`; there is no `style` field.
 * Since sparse chart records deserialize (`format` optional), both reach the
 * picker.
 *
 * INTENDED behaviour:
 *  - a mapstyleJSON card applies the style document at `url` to the main map;
 *  - a chart the app has no render path for (tileJSON) is not offered as a
 *    card, because tapping it clears the base layer and draws nothing.
 *
 * On unfixed main: the picker shows 4 cards (tileJSON included), and tapping
 * the mapstyleJSON card leaves the main map blank (style never applied).
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles } from '../lib/app';

const MAGENTA = [255, 0, 255] as const;

/** Decode a screenshot in the page and return the RGB at (x, y). */
async function pixelAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({ b64, px, py }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(px, py, 1, 1).data;
    return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as [number, number, number];
  }, { b64: png, px: x, py: y });
}

test('mapstyleJSON chart applies its url style; tileJSON chart is not offered', async ({ page }) => {
  const mock = new MockSignalK();
  const port = await mock.start();

  try {
    mock.restRoutes.set('/signalk/v2/api/resources/charts', {
      styled: { identifier: 'styled', name: 'Styled chart', type: 'mapstyleJSON', url: '/s.json' },
      tj:     { identifier: 'tj',     name: 'TileJSON chart', type: 'tileJSON',   url: '/tj.json' },
    });
    mock.restRoutes.set('/s.json', {
      version: 8,
      sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': 'rgb(255,0,255)' } }],
    });

    await seedApp(page, { port });
    await blockExternalTiles(page);
    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', 'rgb(74, 222, 128)', { timeout: 20_000 });
    await page.waitForSelector('canvas.maplibregl-canvas');

    await page.locator('button[title="Charts & layers"]').click();
    const grid = page.locator('.grid');
    await expect(grid.locator('.card', { hasText: 'Styled chart' })).toHaveCount(1, { timeout: 15_000 });
    // 2 base layers + the mapstyleJSON chart; the unrenderable tileJSON chart is omitted.
    await expect(grid.locator('.card')).toHaveCount(3);

    await grid.locator('.card', { hasText: 'Styled chart' }).click();

    // The style's magenta background fills the main map.
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    await expect.poll(() => pixelAt(page, Math.round(vp.width / 2), Math.round(vp.height / 2)), { timeout: 15_000 })
      .toEqual([...MAGENTA]);
  } finally {
    await mock.stop();
  }
});
