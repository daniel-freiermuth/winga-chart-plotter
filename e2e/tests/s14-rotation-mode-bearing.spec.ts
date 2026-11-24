/**
 * S14 — the selected rotation mode must actually rotate the chart.
 *
 * Map.svelte's follow/rotation effect turns the rotation mode into a MapLibre
 * bearing: north-up = 0°, COG-up / HDG-up = own COG / heading (Signal K
 * radians → degrees), course-up = great-circle bearing from own ship to
 * navigation.course.nextPoint. A unit slip, swapped COG/heading or a sign flip
 * would rotate the chart to the wrong heading while the compass label still
 * reads correctly — so these tests read the camera, not the label.
 *
 * Oracle: the compass needle is drawn as `rotate(-bearing, 22, 22)` from the
 * map's `rotate` events (mapView.bearing = map.getBearing()).
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK, OWN_ID } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, VIEW } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const DEG = 180 / Math.PI;
/** Max accepted angular error between the camera bearing and the expected one. */
const TOLERANCE_DEG = 0.1;

const compass = (page: Page) => page.locator('.nav-stack button.compass-fab').first();
const followButton = (page: Page) => page.locator('.nav-stack button.nav-fab').nth(1);

/** Current map bearing in degrees, read back from the compass needle. */
async function chartBearing(page: Page): Promise<number> {
  const t = await compass(page).locator('g[transform^="rotate("]').getAttribute('transform');
  const m = /^rotate\(([^,]+),/.exec(t ?? '');
  if (m === null) throw new Error(`unexpected compass needle transform: ${String(t)}`);
  return -Number(m[1]);
}

/** Smallest absolute difference between two bearings, in degrees. */
function angleDiff(a: number, b: number): number {
  const d = (((a - b) % 360) + 540) % 360 - 180;
  return Math.abs(d);
}

async function expectBearing(page: Page, expectedDeg: number): Promise<void> {
  await expect
    .poll(async () => angleDiff(await chartBearing(page), expectedDeg), {
      message: `chart bearing should settle at ${expectedDeg.toFixed(3)}°`,
      timeout: 10_000,
    })
    .toBeLessThan(TOLERANCE_DEG);
}

/** Initial great-circle bearing (degrees, 0..360) — independent test oracle. */
function gcInitialBearingDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const φ1 = lat1 / DEG;
  const φ2 = lat2 / DEG;
  const Δλ = (lon2 - lon1) / DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * DEG) + 360) % 360;
}

/**
 * App on the mock, streaming own position/COG (+ optional heading / next point)
 * every 500 ms. `nav` is read on every tick, so tests may mutate it.
 */
async function connect(
  page: Page,
  mock: MockSignalK,
  nav: { cogRad: number; headingRad?: number; nextPoint?: { lon: number; lat: number } },
): Promise<void> {
  const port = await mock.start();
  await seedApp(page, { port });
  await blockExternalTiles(page);
  await page.goto('/');
  await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });
  mock.every(500, () => {
    mock.ownNav({ lon: VIEW.lon, lat: VIEW.lat, cogRad: nav.cogRad, sogMs: 3 });
    const extra: { path: string; value: unknown }[] = [];
    if (nav.headingRad !== undefined) extra.push({ path: 'navigation.headingTrue', value: nav.headingRad });
    if (nav.nextPoint !== undefined) {
      extra.push({
        path: 'navigation.course.nextPoint',
        value: { position: { longitude: nav.nextPoint.lon, latitude: nav.nextPoint.lat } },
      });
    }
    if (extra.length > 0) mock.delta(OWN_ID, extra);
  });
  await expect(followButton(page)).toBeEnabled({ timeout: 10_000 });
  await expectBearing(page, 0); // seeded north-up camera
}

/** Tap the compass and wait for the given mode label. */
async function cycleTo(page: Page, label: 'N' | 'COG' | 'HDG' | 'BRG'): Promise<void> {
  await compass(page).click();
  await expect(compass(page)).toHaveAttribute('aria-label', new RegExp(`Rotation mode: ${label} `));
}

test('COG-up turns the chart to own COG in degrees, tracks COG changes, and north-up returns to 0°', async ({ page }) => {
  const mock = new MockSignalK(OWN_ID);
  try {
    const nav = { cogRad: 0.5 };
    await connect(page, mock, nav);
    await cycleTo(page, 'COG');
    await expectBearing(page, 0.5 * DEG); // 28.65°, not 0.5° (radians leaked) nor -28.65° (sign flip)

    // A new COG must re-rotate the not-following chart.
    nav.cogRad = 2.5;
    await expectBearing(page, 2.5 * DEG); // 143.24°

    // Only COG is available, so the next tap returns to north-up.
    await cycleTo(page, 'N');
    await expectBearing(page, 0);
  } finally {
    await mock.stop();
  }
});

test('COG-up rotates the chart while following own vessel', async ({ page }) => {
  const mock = new MockSignalK(OWN_ID);
  try {
    await connect(page, mock, { cogRad: Math.PI / 2 });
    await followButton(page).click();
    await expect(followButton(page)).toHaveAttribute('title', 'Stop following vessel');
    await cycleTo(page, 'COG');
    await expectBearing(page, 90); // east up
  } finally {
    await mock.stop();
  }
});

/**
 * Sample the chart bearing for 2.5 s (several 500 ms stream ticks): it must
 * stay at `heldDeg` the whole time.
 */
async function expectBearingHeld(page: Page, heldDeg: number, message: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(250);
    expect(angleDiff(await chartBearing(page), heldDeg), message).toBeLessThan(TOLERANCE_DEG);
  }
}

/** Press the mouse on the canvas and drag a little, without releasing: a pan gesture in progress. */
async function holdMouseDrag(page: Page): Promise<void> {
  const canvas = await page.locator('.maplibregl-canvas').boundingBox();
  if (!canvas) throw new Error('map canvas not laid out');
  const x = canvas.x + canvas.width * 0.7;
  const y = canvas.y + canvas.height * 0.3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y - 50, { steps: 10 });
}

// A finger on the chart wins over the follow/rotation effect: a COG change
// while the helmsman's finger is down must not rotate (or recentre) the chart
// under it; once the finger lifts, COG updates rotate the chart again.
test('COG-up does not rotate the followed chart while a finger is held on it', async ({ page }) => {
  const mock = new MockSignalK(OWN_ID);
  try {
    const nav = { cogRad: Math.PI / 2 };
    await connect(page, mock, nav);
    await followButton(page).click();
    await expect(followButton(page)).toHaveAttribute('title', 'Stop following vessel');
    await cycleTo(page, 'COG');
    await expectBearing(page, 90);

    // Real touch held on the canvas (touchStart, no touchEnd) — MapLibre's
    // touchstart sets the gesture guard, only touchend/touchcancel clears it.
    const canvas = await page.locator('.maplibregl-canvas').boundingBox();
    if (!canvas) throw new Error('map canvas not laid out');
    const finger = { x: canvas.x + canvas.width * 0.7, y: canvas.y + canvas.height * 0.3, id: 1 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger] });

    nav.cogRad = 2.5;
    await expectBearingHeld(page, 90, 'chart rotated under a held finger');

    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    // Next COG update after the lift rotates the chart again (guard released).
    nav.cogRad = 2.0;
    await expectBearing(page, 2.0 * DEG); // 114.59°
  } finally {
    await mock.stop();
  }
});

// Same for a mouse drag (desktop / plain browser path, where no touch guard is
// ever set): a pan in progress wins over the follow/rotation effect.
test('COG-up does not rotate the followed chart during a held mouse drag', async ({ page }) => {
  const mock = new MockSignalK(OWN_ID);
  try {
    const nav = { cogRad: Math.PI / 2 };
    await connect(page, mock, nav);
    await followButton(page).click();
    await expect(followButton(page)).toHaveAttribute('title', 'Stop following vessel');
    await cycleTo(page, 'COG');
    await expectBearing(page, 90);

    await holdMouseDrag(page);
    nav.cogRad = 2.5;
    await expectBearingHeld(page, 90, 'followed chart rotated under a held mouse drag');

    await page.mouse.up();
    // The short drag leaves the vessel on screen, so follow stays on (offset slid).
    await expect(followButton(page)).toHaveAttribute('title', 'Stop following vessel');
    nav.cogRad = 2.0;
    await expectBearing(page, 2.0 * DEG); // 114.59°
  } finally {
    await mock.stop();
  }
});

test('COG-up does not rotate the unfollowed chart during a held mouse drag', async ({ page }) => {
  const mock = new MockSignalK(OWN_ID);
  try {
    const nav = { cogRad: Math.PI / 2 };
    await connect(page, mock, nav);
    await cycleTo(page, 'COG');
    await expectBearing(page, 90);

    await holdMouseDrag(page);
    nav.cogRad = 2.5;
    await expectBearingHeld(page, 90, 'unfollowed chart rotated under a held mouse drag');

    await page.mouse.up();
    nav.cogRad = 2.0;
    await expectBearing(page, 2.0 * DEG); // 114.59°
  } finally {
    await mock.stop();
  }
});

test('HDG-up follows own heading, not COG', async ({ page }) => {
  const mock = new MockSignalK(OWN_ID);
  try {
    await connect(page, mock, { cogRad: 0.5, headingRad: 1.2 });
    await cycleTo(page, 'COG');
    await expectBearing(page, 0.5 * DEG);
    await cycleTo(page, 'HDG');
    await expectBearing(page, 1.2 * DEG); // 68.75°, distinct from COG 28.65°
  } finally {
    await mock.stop();
  }
});

test('course-up points the chart along the great circle to the next point', async ({ page }) => {
  const mock = new MockSignalK(OWN_ID);
  // Due east along the parallel, 6° of longitude away: the great-circle initial
  // bearing (~87.4°) differs measurably from both the rhumb line (90°) and COG.
  const nextPoint = { lon: VIEW.lon + 6, lat: VIEW.lat };
  const expected = gcInitialBearingDeg(VIEW.lon, VIEW.lat, nextPoint.lon, nextPoint.lat);
  expect(angleDiff(expected, 90)).toBeGreaterThan(1);
  try {
    await connect(page, mock, { cogRad: 0.5, nextPoint });
    await cycleTo(page, 'COG');
    await expectBearing(page, 0.5 * DEG);
    await cycleTo(page, 'BRG'); // heading unavailable → COG cycles straight to course-up
    await expectBearing(page, expected);
  } finally {
    await mock.stop();
  }
});
