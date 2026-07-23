/**
 * S1 — bug #1 (PR #7): stranded CPA mini-label.
 *
 * Select an AIS target → CPA label appears. When the target's COG becomes
 * unavailable (AIS sentinel 360° == 2π rad; skdata filters it to NaN and
 * computeCpa then returns null), the CPA recompute effect bails — the label
 * MUST be removed along with the CPA layers.
 *
 * On unfixed main the `!rustCpa` bail path clears cpaLayerGroup but not
 * cpaLabelPopup, so the label stays frozen on the chart indefinitely.
 */
import { test, expect } from '@playwright/test';
import { MockSignalK, COG_SENTINEL_RAD } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, clickLonLat, lonLatAtPx, VIEW } from '../lib/app';

const TARGET_ID = 'urn:mrn:imo:mmsi:257000001';

test('CPA label disappears when the selected target loses COG', async ({ page }) => {
  const mock = new MockSignalK();
  const port = await mock.start();

  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);

    // Own vessel EXACTLY at the view centre: the app auto-flyTo's the first
    // own position fix (Map.svelte, _didAutoFlyToFirstFix), so any other spot
    // would move the camera and break the screen-coordinate math. Target
    // 120 px east, 40 px south, stationary. All CPA inputs valid → label shows.
    const own = { lon: VIEW.lon, lat: VIEW.lat };
    const tgt = lonLatAtPx(VIEW, 120, 40);
    let targetCog = 0; // valid COG; later flipped to the 2π sentinel

    await page.goto('/');
    mock.every(1000, () => {
      mock.ownNav({ lon: own.lon, lat: own.lat, cogRad: Math.PI / 2, sogMs: 3 });
      mock.aisReport(TARGET_ID, {
        lon: tgt.lon, lat: tgt.lat, cogRad: targetCog, sogMs: 0, name: 'SENTINEL TEST',
      });
    });

    // Connected = green settings gear.
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', 'rgb(74, 222, 128)', { timeout: 20_000 });

    // First click on the vessel highlights it and shows the CPA label.
    const cpaLabel = page.locator('.maplibregl-popup.ais-cpa-label');
    await expect(async () => {
      await clickLonLat(page, VIEW, tgt.lon, tgt.lat);
      await expect(cpaLabel).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await expect(cpaLabel).toContainText('CPA');

    // Target now reports "COG not available".
    targetCog = COG_SENTINEL_RAD;

    // INTENDED behaviour: no CPA can be computed → label is removed.
    // Unfixed main: label stays frozen (this expectation times out).
    await expect(cpaLabel).toBeHidden({ timeout: 8000 });
  } finally {
    await mock.stop();
  }
});
