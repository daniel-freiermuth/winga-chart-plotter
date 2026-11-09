/**
 * S13 — editing the active route: a failed re-activation must be visible.
 *
 * App.svelte `handleSaveRoute`, after updating the route being navigated,
 * re-activates it (PUT …/navigation/course/activeRoute) and re-anchors the
 * point index so navigation follows the edited geometry. It called
 * `routePlanner.exit()` before those requests, so when they failed or timed
 * out (15 s, ROUTE_COURSE_TIMEOUT_MS) the error went to `plannerError`, which
 * is only rendered inside the — by then closed — planner HUD. The crew got no
 * sign that navigation still follows the pre-edit course, and the stale error
 * popped up in the next, unrelated planner session instead.
 *
 * INTENDED behaviour (CHANGELOG, S10): the re-activation times out "into the
 * planner's error message, with Save usable again and the planned route
 * kept" — so the planner stays open on the edited route with the error, and
 * Update can retry. A save's outcome belongs to its own planner session: it
 * must neither close nor write into a later session (even one on the same
 * route), and must not throw away edits made while it was pending. Once the
 * update is on the server, Discard is withheld until navigation is
 * re-anchored: there is nothing left to discard, and discarding would hide a
 * failed re-anchor again.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { MockSignalK, OWN_ID } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, clickLonLat, lonLatAtPx, pagePoint, VIEW } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const ROUTE_UUID = 'e2e00000-0000-4000-8000-000000000013';
const ROUTE_NAME = 'E2E active edit';
const ROUTES_PATH = '/signalk/v2/api/resources/routes';
const COMPLETED = { status: 200, contentType: 'application/json', body: '{"state":"COMPLETED","statusCode":200}' };

const updateButton = (page: Page) => page.locator('button[title="Update route"]');
const nameInput = (page: Page) => page.getByPlaceholder('Route name…');

interface Course {
  /** The pending route update PUT, held unanswered until the test settles it. */
  update: () => Route | null;
  /** The pending re-activation PUT, held unanswered until the test settles it. */
  activate: () => Route | null;
  pointIndexPut: () => boolean;
  /** Last point of the active route: clicking it opens the active-route popup. */
  last: { lon: number; lat: number };
}

/**
 * App connected to a mock streaming ROUTE_UUID as the active route (3 points),
 * logged in, with the pointIndex PUT answered 200. The route update PUT and
 * the re-activation PUT are held: never answered unless the test fulfils them.
 */
async function setup(page: Page, mock: MockSignalK): Promise<Course> {
  const port = await mock.start();
  await seedApp(page, { port });
  // Editing needs a login; the mock 404s /auth/validate, so the stored token is kept.
  await page.addInitScript((serverBase) => {
    localStorage.setItem('sk-auth', JSON.stringify({ serverBase, token: 'e2e-token', username: 'e2e' }));
  }, `http://127.0.0.1:${String(port)}`);
  await blockExternalTiles(page);

  const first = lonLatAtPx(VIEW, -200, -120);
  const mid   = lonLatAtPx(VIEW, 0, -120);
  const last  = lonLatAtPx(VIEW, 200, -120);
  const resource = {
    name: ROUTE_NAME,
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[first.lon, first.lat], [mid.lon, mid.lat], [last.lon, last.lat]] },
      properties: {},
    },
  };
  mock.restRoutes.set(`${ROUTES_PATH}/${ROUTE_UUID}`, resource);
  mock.restRoutes.set(ROUTES_PATH, { [ROUTE_UUID]: resource });

  let update: Route | null = null;
  await page.route(`**${ROUTES_PATH}/${ROUTE_UUID}`, async (route) => {
    if (route.request().method() === 'PUT') {
      update = route;
      return;
    }
    await route.continue();
  });
  let activate: Route | null = null;
  await page.route('**/navigation/course/activeRoute', async (route) => {
    if (route.request().method() === 'PUT') {
      activate = route;
      return;
    }
    await route.continue();
  });
  let pointIndexPut = false;
  await page.route('**/navigation/course/activeRoute/pointIndex', async (route) => {
    pointIndexPut = true;
    await route.fulfill(COMPLETED);
  });

  await page.goto('/');
  mock.every(1000, () => {
    mock.ownNav({ lon: VIEW.lon, lat: VIEW.lat, cogRad: Math.PI / 2, sogMs: 3 });
    mock.delta(OWN_ID, [
      { path: 'navigation.course.nextPoint', value: { position: { longitude: mid.lon, latitude: mid.lat } } },
      { path: 'navigation.course.activeRoute', value: {
        href: `/resources/routes/${ROUTE_UUID}`, name: ROUTE_NAME, pointIndex: 1, reverse: false,
      } },
    ]);
  });
  await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });
  await openActiveRouteEditor(page, last);
  return { update: () => update, activate: () => activate, pointIndexPut: () => pointIndexPut, last };
}

/** Open the active route in the planner via its popup's "Edit route". */
async function openActiveRouteEditor(page: Page, at: { lon: number; lat: number }): Promise<void> {
  await expect(async () => {
    await page.keyboard.press('Escape');
    await clickLonLat(page, VIEW, at.lon, at.lat);
    await expect(page.locator('.maplibregl-popup .edit-active-route-btn')).toBeEnabled({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await page.locator('.maplibregl-popup .edit-active-route-btn').click();
  await expect(nameInput(page)).toHaveValue(ROUTE_NAME);
}

/** Wait until a held request has arrived and return it. */
async function heldRequest(get: () => Route | null, what: string): Promise<Route> {
  await expect.poll(() => get() !== null, { timeout: 10_000 }).toBe(true);
  const held = get();
  if (held === null) throw new Error(`${what} not held`);
  return held;
}

/** Click Update, let the route update succeed, and wait until the re-activation PUT is held. */
async function updateAndHoldActivation(page: Page, course: Course): Promise<Route> {
  await updateButton(page).click();
  await (await heldRequest(course.update, 'route update PUT')).fulfill(COMPLETED);
  return heldRequest(course.activate, 're-activation PUT');
}

/** Add a planner waypoint by clicking open water south of the route and own vessel. */
async function addWaypoint(page: Page): Promise<void> {
  const p = await pagePoint(page, VIEW, VIEW.lon + 0.005, VIEW.lat - 0.002);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByText('4 waypoints')).toBeVisible();
}

test('a hung re-activation after editing the active route shows in the planner, not the next session', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const course = await setup(page, mock);
    await updateAndHoldActivation(page, course); // Never fulfilled, aborted or continued.

    // The re-activation times out into the planner's error; the edited route
    // stays open and Update is usable again for a retry.
    await expect(page.getByText(/timed out/i)).toBeVisible({ timeout: 25_000 });
    await expect(nameInput(page)).toHaveValue(ROUTE_NAME);
    await expect(updateButton(page)).toHaveText('Update');
    await expect(updateButton(page)).toBeEnabled();

    // Giving up on the edit closes that session's error with it: a fresh
    // planner session starts clean.
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(nameInput(page)).toHaveCount(0);
    const start = await pagePoint(page, VIEW, VIEW.lon - 0.005, VIEW.lat + 0.003);
    await page.mouse.click(start.x, start.y, { button: 'right' });
    await page.locator('.maplibregl-popup .route-here-btn').click();
    await expect(nameInput(page)).toHaveValue('');
    await expect(page.getByText(/timed out/i)).toHaveCount(0);
  } finally {
    await mock.stop();
  }
});

test('a late successful save does not close a newer session on the same route', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const course = await setup(page, mock);
    await updateButton(page).click();
    const update = await heldRequest(course.update, 'route update PUT');

    // Discard while the update is still unanswered (the S10 escape hatch),
    // reopen the same active route and edit it.
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(nameInput(page)).toHaveCount(0);
    await openActiveRouteEditor(page, course.last);
    await addWaypoint(page);

    // The old save now completes, re-activation and re-anchor included.
    await update.fulfill(COMPLETED);
    await (await heldRequest(course.activate, 're-activation PUT')).fulfill(COMPLETED);
    await expect.poll(course.pointIndexPut).toBe(true);
    await expect(updateButton(page)).toHaveText('Update');

    // The newer session and its unsaved edit are still there.
    await expect(nameInput(page)).toHaveValue(ROUTE_NAME);
    await expect(page.getByText('4 waypoints')).toBeVisible();
  } finally {
    await mock.stop();
  }
});

test('a late failed save does not write its error into a newer session on the same route', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const course = await setup(page, mock);
    await updateButton(page).click();
    const update = await heldRequest(course.update, 'route update PUT');

    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(nameInput(page)).toHaveCount(0);
    await openActiveRouteEditor(page, course.last);

    // The discarded save's update now fails — nothing reached the server.
    await update.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"mock failure"}' });
    await expect(updateButton(page)).toHaveText('Update');

    await expect(nameInput(page)).toHaveValue(ROUTE_NAME);
    await expect(page.getByText(/Update route failed/)).toHaveCount(0);
  } finally {
    await mock.stop();
  }
});

test('once the edit is saved, Discard is not offered while navigation is re-anchored, and a failed re-anchor shows', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const course = await setup(page, mock);
    const activate = await updateAndHoldActivation(page, course);

    // The edit is on the server: there is nothing left to discard.
    await expect(page.locator('button[title="Discard and exit route planner"]')).toBeDisabled();
    await expect(page.getByText('Route saved — re-anchoring navigation…')).toBeVisible();

    await activate.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"mock failure"}' });
    await expect(page.getByText(/Activate route failed/)).toBeVisible();
    await expect(updateButton(page)).toHaveText('Update');
    await expect(updateButton(page)).toBeEnabled();
    await expect(page.locator('button[title="Discard and exit route planner"]')).toBeEnabled();
  } finally {
    await mock.stop();
  }
});

test('edits made while the re-activation is pending are not thrown away', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const course = await setup(page, mock);
    const held = await updateAndHoldActivation(page, course);

    // A correction made while the save is still re-anchoring navigation.
    await addWaypoint(page);

    await held.fulfill(COMPLETED);
    await expect.poll(course.pointIndexPut).toBe(true);
    await expect(updateButton(page)).toHaveText('Update');

    // Not sent yet — the planner stays open with it, Update saves it.
    await expect(nameInput(page)).toHaveValue(ROUTE_NAME);
    await expect(page.getByText('4 waypoints')).toBeVisible();
    await expect(updateButton(page)).toBeEnabled();
  } finally {
    await mock.stop();
  }
});

test('a Discard confirm left open while the update commits is withdrawn and does not carry over', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const course = await setup(page, mock);
    await updateButton(page).click();
    const update = await heldRequest(course.update, 'route update PUT');

    // Discard asked, not yet confirmed, when the update reaches the server.
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByText('Discard changes to this route?')).toBeVisible();
    await update.fulfill(COMPLETED);
    // The changes are saved now — the confirm no longer applies.
    await expect(page.getByText('Discard changes to this route?')).toHaveCount(0);
    await expect(page.locator('button[title="Discard and exit route planner"]')).toBeDisabled();

    await (await heldRequest(course.activate, 're-activation PUT')).fulfill(COMPLETED);
    await expect.poll(course.pointIndexPut).toBe(true);
    await expect(nameInput(page)).toHaveCount(0);

    // A new session opens with the normal Discard control, not the stale confirm.
    const start = await pagePoint(page, VIEW, VIEW.lon - 0.005, VIEW.lat + 0.003);
    await page.mouse.click(start.x, start.y, { button: 'right' });
    await page.locator('.maplibregl-popup .route-here-btn').click();
    await expect(nameInput(page)).toHaveValue('');
    await expect(page.locator('button[title="Discard and exit route planner"]')).toBeVisible();
    await expect(page.getByText('Discard route and all waypoints?')).toHaveCount(0);
  } finally {
    await mock.stop();
  }
});
