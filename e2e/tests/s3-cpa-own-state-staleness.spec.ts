/**
 * S3 — bug #5 (PR #9): CPA readout frozen between slow target reports.
 *
 * The CPA $effect reads own-vessel state via untrack(), so its only recompute
 * triggers are AIS snapshot uploads and selection changes. AIS snapshots are
 * emitted per incoming WebSocket message — which means the freeze is only
 * observable when own state updates WITHOUT WS traffic: geolocation mode.
 *
 * Setup: geo mode with a stubbed 1 Hz geolocation watch drifting north at
 * 5 m/s; a single stationary AIS target that reports ONCE. Own track runs due
 * east, target sits south-east, so the CPA distance grows ~5 m/s — the label's
 * `CPA x.xxnm` text (0.01 nm = 18.5 m resolution) must tick every ~4 s.
 *
 * Fixed code refreshes the effect every 5 s while a target is selected →
 * label text changes within the 15 s window. Unfixed main: no WS traffic, no
 * recompute — the text stays frozen until the next target report (none here).
 */
import { test, expect } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import {
  seedApp, blockExternalTiles, stubGeolocation, clickLonLat, lonLatAtPx, VIEW,
} from '../lib/app';

const TARGET_ID = 'urn:mrn:imo:mmsi:257000201';

test('CPA label follows own-vessel movement between target reports', async ({ page }) => {
  const mock = new MockSignalK();
  const port = await mock.start();

  try {
    await seedApp(page, { port, useGeoLocation: true });
    await blockExternalTiles(page);
    // Own vessel at the view centre (auto-flyTo no-op), heading east at
    // 3 m/s, fix drifting north 5 m/s — own state changes at 1 Hz with zero
    // WebSocket traffic.
    await stubGeolocation(page, {
      lon: VIEW.lon, lat: VIEW.lat, headingDeg: 90, speedMs: 3, driftNorthMs: 5,
    });

    const tgt = lonLatAtPx(VIEW, 120, 40); // south-east of own track

    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', 'rgb(74, 222, 128)', { timeout: 20_000 });

    // Exactly ONE target report — a slow Class-B target between reports.
    const report = () => {
      mock.aisReport(TARGET_ID, { lon: tgt.lon, lat: tgt.lat, cogRad: 0, sogMs: 0, name: 'SLOWPOKE' });
    };
    report();

    const cpaLabel = page.locator('.maplibregl-popup.ais-cpa-label');
    await expect(async () => {
      await clickLonLat(page, VIEW, tgt.lon, tgt.lat);
      await expect(cpaLabel).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await expect(cpaLabel).toContainText('nm');

    // Re-report once so the baseline text reflects CURRENT own position (the
    // selection could have taken a while), then freeze the airwaves entirely.
    const fromIdle = mock.requests.length; // marker only for readability
    void fromIdle;
    report();
    await page.waitForTimeout(1500);
    const baseline = await cpaLabel.innerText();

    // Own fix keeps drifting north at 5 m/s (~0.01 nm CPA change per ~4 s).
    // INTENDED: the label refreshes from own movement alone within ~5-10 s.
    // Unfixed main: nothing reruns the CPA effect — text frozen indefinitely.
    await expect(cpaLabel).not.toHaveText(baseline, { timeout: 15_000 });
  } finally {
    await mock.stop();
  }
});
