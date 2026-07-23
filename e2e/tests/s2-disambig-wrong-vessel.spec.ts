/**
 * S2 — bug #4 (PR #6): disambiguation popup selects the wrong vessel.
 *
 * The "Multiple vessels" popup freezes each entry's per-batch array index
 * (`data-idx`) into the HTML when it opens. The AIS ids array is rebuilt from
 * a Rust HashMap on every batch, so its order shifts whenever the set of live
 * vessels changes. Clicking an entry after a few churn batches resolves the
 * stale index against the *current* array — selecting whichever vessel now
 * happens to sit at that index (or nothing at all).
 *
 * Fixed code resolves the entry to a stable vessel id first, then looks the
 * id up at click time — the click always selects the vessel whose name the
 * user tapped.
 *
 * Selection oracle: highlighting a vessel fires a REST position-history fetch
 * whose URL carries the vessel id; the mock records it. No DOM guessing.
 */
import { test, expect } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, clickLonLat, lonLatAtPx, VIEW } from '../lib/app';

const ALPHA_ID = 'urn:mrn:imo:mmsi:257000101';
const BRAVO_ID = 'urn:mrn:imo:mmsi:257000102';
const CHURN_IDS = Array.from({ length: 8 }, (_, i) => `urn:mrn:imo:mmsi:25790000${String(i)}`);
// Second-wave population swapped in while the popup is open (see below).
const WAVE2_IDS = Array.from({ length: 24 }, (_, i) => `urn:mrn:imo:mmsi:2579100${String(i).padStart(2, '0')}`);

test('clicking a disambiguation entry selects the named vessel', async ({ page }) => {
  const mock = new MockSignalK();
  const port = await mock.start();

  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);

    // Own vessel EXACTLY at the view centre (the app auto-flyTo's the first
    // fix; centre = no camera movement). ALPHA and BRAVO 4 px apart around
    // (120, 40) — both inside deck.gl's 5 px pick radius of the midpoint.
    const own = { lon: VIEW.lon, lat: VIEW.lat };
    const alpha = lonLatAtPx(VIEW, 118, 40);
    const bravo = lonLatAtPx(VIEW, 122, 40);
    const mid = lonLatAtPx(VIEW, 120, 40);
    // Churn vessels far away (never picked, never on the popup) whose
    // presence toggles per batch — appear via a fresh report, vanish via a
    // back-dated datetime. Each toggle changes the set of vessels surviving
    // the stale filter and with it ALPHA/BRAVO's index in the snapshot array.
    // Three toggle-rate groups (every 1, 2, and 4 batches) give the schedule
    // period 8: any two batches less than 8 apart carry a DIFFERENT churn
    // set, so a popup held open across batches never sees indices realign.
    let batch = 0;
    let phase: 'churn' | 'reshuffled' = 'churn';

    await page.goto('/');
    mock.every(1000, () => {
      batch++;
      mock.ownNav({ lon: own.lon, lat: own.lat, cogRad: Math.PI / 2, sogMs: 3 });
      mock.aisReport(ALPHA_ID, { lon: alpha.lon, lat: alpha.lat, cogRad: 0, sogMs: 0, name: 'ALPHA' });
      mock.aisReport(BRAVO_ID, { lon: bravo.lon, lat: bravo.lat, cogRad: 0, sogMs: 0, name: 'BRAVO' });
      if (phase === 'churn') {
        CHURN_IDS.forEach((id, i) => {
          const spot = lonLatAtPx(VIEW, -400 + 30 * i, -250);
          if (((batch >> (i % 3)) & 1) === 0) {
            mock.aisReport(id, { lon: spot.lon, lat: spot.lat, cogRad: 0, sogMs: 0, name: `CHURN ${String(i)}` });
          } else {
            mock.expire(id);
          }
        });
      } else {
        CHURN_IDS.forEach((id) => { mock.expire(id); });
        WAVE2_IDS.forEach((id, i) => {
          const spot = lonLatAtPx(VIEW, -420 + 25 * i, -250);
          mock.aisReport(id, { lon: spot.lon, lat: spot.lat, cogRad: 0, sogMs: 0, name: `WAVE ${String(i)}` });
        });
      }
    });

    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', 'rgb(74, 222, 128)', { timeout: 20_000 });

    // Tap the midpoint until the disambiguation popup opens AND lists both
    // overlapping vessels. (The popup is built by resolving deck.gl pick
    // indices against the live ids array; under churn a tap can land in the
    // one-frame window where those disagree and list the wrong vessels — on
    // main that is the same stale-index bug, on the fix branch it is a
    // harmless frame race. Either way: close and tap again.)
    const list = page.locator('.ais-disambig-list');
    const bravoItem = list.locator('.ais-disambig-item', { hasText: 'BRAVO' });
    await expect(async () => {
      const close = page.locator('.maplibregl-popup-close-button');
      if (await close.count()) await close.first().click();
      await clickLonLat(page, VIEW, mid.lon, mid.lat);
      await expect(list).toBeVisible({ timeout: 2000 });
      await expect(list.locator('.ais-disambig-item', { hasText: 'ALPHA' })).toBeVisible({ timeout: 500 });
      await expect(bravoItem).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 45_000 });

    // Reshuffle the snapshot array under the open popup: expire every original
    // churn vessel and report 24 fresh ones. The vessels HashMap must grow to
    // hold them (rehash), so the per-batch array order is rebuilt from scratch
    // — the popup's frozen data-idx almost surely points at a different vessel
    // now. Let a few batches of the new population land before clicking.
    phase = 'reshuffled';
    await page.waitForTimeout(3500);

    // Click the entry labelled BRAVO; the app must select BRAVO.
    //
    // Two positive signals, depending on prior state: a FRESH selection fires
    // the track-history fetch (URL carries the vessel id); if BRAVO was
    // already highlighted by a single-target tap during the retry loop above,
    // the click elevates straight to the info popup titled with the vessel's
    // name. Either reveals which vessel the app actually selected. On unfixed
    // main the stale index resolves to a churn vessel (wrong-id fetch) or to
    // nothing at all (no fetch, no popup).
    const fromIndex = mock.requests.length;
    await bravoItem.click();
    const requestedId = await mock.waitForTrackRequest(fromIndex, 8000).catch(() => null);
    if (requestedId !== null) {
      expect(requestedId, 'track-history fetch fired by selecting the clicked vessel').toBe(BRAVO_ID);
    } else {
      const infoTitle = page
        .locator('.maplibregl-popup .ais-popup-title')
        .filter({ hasNotText: 'Multiple vessels' });
      await expect(infoTitle, 'info popup for the vessel the app selected').toHaveText('BRAVO');
    }
  } finally {
    await mock.stop();
  }
});
