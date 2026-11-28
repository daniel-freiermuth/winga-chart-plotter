/**
 * S15 — editing the active route re-anchors on the course in effect at save.
 *
 * After updating the active route, App.svelte `handleSaveRoute` re-activates
 * it (Signal K restarts at pointIndex 0) and PUTs the point index of the
 * edited waypoint closest to the next point. That next point was captured
 * when the planner opened, so a course that advanced during the edit
 * (arrival auto-advance, another chartplotter) was rolled back to the
 * waypoint already reached; a route that became active during an edit
 * started from the all-routes popup was left at point 0.
 *
 * INTENDED behaviour: the re-anchor restores navigation to the edited route's
 * equivalent of the point Signal K is navigating to when the edit is saved.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { MockSignalK, OWN_ID } from '../mock-signalk/server';
import {
  seedApp, blockExternalTiles, lonLatAtPx, openRouteEditor, routeNameInput, updateRouteButton,
  COMPLETED, MOCK_FAILURE, ROUTES_PATH, VIEW,
} from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const ROUTE_UUID = 'e2e00000-0000-4000-8000-000000000015';
const ROUTE_NAME = 'E2E reanchor';

type LonLat = { lon: number; lat: number };

interface Harness {
  /** Route geometry A-B-C-D, west to east, well clear of the own vessel. */
  points: [LonLat, LonLat, LonLat, LonLat];
  /** Stream this course (null: no active route); resolves once the app has had time to apply it. */
  setCourse: (pointIndex: number | null) => Promise<void>;
  /** Bodies of every PUT …/activeRoute/pointIndex, in order. */
  pointIndexPuts: unknown[];
  /** Answer this many upcoming pointIndex PUTs 500 instead of 200. */
  failPointIndexPuts: (n: number) => void;
  /** Held re-activation PUTs, in arrival order. */
  activates: Route[];
  /** Held route update PUTs, in arrival order. */
  updates: Route[];
}

/**
 * App connected to a mock with a 4-point route ROUTE_UUID, logged in. The
 * route update and re-activation PUTs are held for the test to settle; the
 * pointIndex PUT is answered (200 by default) and its body recorded.
 */
async function setup(page: Page, mock: MockSignalK, initialPointIndex: number | null): Promise<Harness> {
  const port = await mock.start();
  await seedApp(page, { port });
  await page.addInitScript((serverBase) => {
    localStorage.setItem('sk-auth', JSON.stringify({ serverBase, token: 'e2e-token', username: 'e2e' }));
  }, `http://127.0.0.1:${String(port)}`);
  await blockExternalTiles(page);

  const points: Harness['points'] = [
    lonLatAtPx(VIEW, -300, -120), lonLatAtPx(VIEW, -100, -120),
    lonLatAtPx(VIEW, 100, -120), lonLatAtPx(VIEW, 300, -120),
  ];
  const resource = {
    name: ROUTE_NAME,
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) },
      properties: {},
    },
  };
  mock.restRoutes.set(`${ROUTES_PATH}/${ROUTE_UUID}`, resource);
  mock.restRoutes.set(ROUTES_PATH, { [ROUTE_UUID]: resource });

  const updates: Route[] = [];
  await page.route(`**${ROUTES_PATH}/${ROUTE_UUID}`, async (route) => {
    if (route.request().method() === 'PUT') { updates.push(route); return; }
    await route.continue();
  });
  const activates: Route[] = [];
  await page.route('**/navigation/course/activeRoute', async (route) => {
    if (route.request().method() === 'PUT') { activates.push(route); return; }
    await route.continue();
  });
  const pointIndexPuts: unknown[] = [];
  let pointIndexFailures = 0;
  await page.route('**/navigation/course/activeRoute/pointIndex', async (route) => {
    pointIndexPuts.push(route.request().postDataJSON());
    if (pointIndexFailures > 0) {
      pointIndexFailures--;
      await route.fulfill(MOCK_FAILURE);
      return;
    }
    await route.fulfill(COMPLETED);
  });

  let pointIndex = initialPointIndex;
  let sentSinceChange = 0;
  await page.goto('/');
  mock.every(1000, () => {
    mock.ownNav({ lon: VIEW.lon, lat: VIEW.lat, cogRad: Math.PI / 2, sogMs: 3 });
    if (pointIndex !== null) {
      const next = points[pointIndex]!;
      mock.delta(OWN_ID, [
        { path: 'navigation.course.nextPoint', value: { position: { longitude: next.lon, latitude: next.lat } } },
        { path: 'navigation.course.activeRoute', value: {
          href: `/resources/routes/${ROUTE_UUID}`, name: ROUTE_NAME, pointIndex, reverse: false,
        } },
      ]);
    }
    sentSinceChange++;
  });
  await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });

  return {
    points,
    async setCourse(pi) {
      pointIndex = pi;
      sentSinceChange = 0;
      // Two ticks: the first delta with the new course has reached the app.
      await expect.poll(() => sentSinceChange, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    },
    pointIndexPuts,
    failPointIndexPuts(n) { pointIndexFailures = n; },
    activates,
    updates,
  };
}

/** Wait until the `i`-th held request has arrived and return it. */
async function heldRequest(held: Route[], i: number, what: string): Promise<Route> {
  await expect.poll(() => held.length, { timeout: 10_000 }).toBeGreaterThan(i);
  const route = held[i];
  if (route === undefined) throw new Error(`${what} #${String(i)} not held`);
  return route;
}

/** Click Update with no edits (the `i`-th save), let the update and re-activation succeed. */
async function saveUnchanged(page: Page, h: Harness, i = 0): Promise<void> {
  await updateRouteButton(page).click();
  await (await heldRequest(h.updates, i, 'route update PUT')).fulfill(COMPLETED);
  await (await heldRequest(h.activates, i, 're-activation PUT')).fulfill(COMPLETED);
}

test('a course that advanced while the active route was edited is kept on save', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const h = await setup(page, mock, 1);
    await openRouteEditor(page, h.points[3], ROUTE_NAME); // Next point B.

    // B reached while editing: the server advances to C.
    await h.setCourse(2);
    await saveUnchanged(page, h);

    await expect.poll(() => h.pointIndexPuts).toEqual([{ value: 2 }]);
    await expect(routeNameInput(page)).toHaveCount(0);
  } finally {
    await mock.stop();
  }
});

test('a route activated elsewhere while edited from the routes list is re-anchored on save', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const h = await setup(page, mock, null);

    // Not active: tapping the route line opens the all-routes popup.
    const [a, b] = h.points;
    await openRouteEditor(page, { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 }, ROUTE_NAME, '.edit-route-btn');

    // Another client activates it and the course is at C by the time of Update.
    await h.setCourse(2);
    await saveUnchanged(page, h);

    await expect.poll(() => h.pointIndexPuts).toEqual([{ value: 2 }]);
    await expect(routeNameInput(page)).toHaveCount(0);
  } finally {
    await mock.stop();
  }
});

test('retrying Update after a failed re-anchor restores the point from before the re-activation', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const h = await setup(page, mock, 2);
    await openRouteEditor(page, h.points[3], ROUTE_NAME); // Next point C.

    // The re-activation lands (Signal K restarts the route at A), the point
    // index PUT fails: the planner stays open on its error.
    h.failPointIndexPuts(1);
    await saveUnchanged(page, h);
    await expect(page.getByText(/Set route point index failed/)).toBeVisible();
    await expect(updateRouteButton(page)).toBeEnabled();
    await h.setCourse(0);

    // The retry re-anchors on C, not on the restarted course's A.
    await saveUnchanged(page, h, 1);
    await expect.poll(() => h.pointIndexPuts).toEqual([{ value: 2 }, { value: 2 }]);
    await expect(routeNameInput(page)).toHaveCount(0);
  } finally {
    await mock.stop();
  }
});

test('retrying Update after a rejected re-activation re-anchors on the course in effect at the retry', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const h = await setup(page, mock, 1);
    await openRouteEditor(page, h.points[3], ROUTE_NAME); // Next point B.

    // The server rejects the re-activation: the course stays at B.
    await updateRouteButton(page).click();
    await (await heldRequest(h.updates, 0, 'route update PUT')).fulfill(COMPLETED);
    await (await heldRequest(h.activates, 0, 're-activation PUT'))
      .fulfill({ status: 403, contentType: 'application/json', body: '{"message":"mock forbidden"}' });
    await expect(page.getByText(/Activate route failed/)).toBeVisible();
    await expect(updateRouteButton(page)).toBeEnabled();

    // B reached before the retry: the server advances to C.
    await h.setCourse(2);
    await saveUnchanged(page, h, 1);
    await expect.poll(() => h.pointIndexPuts).toEqual([{ value: 2 }]);
    await expect(routeNameInput(page)).toHaveCount(0);
  } finally {
    await mock.stop();
  }
});

test('retrying Update after a re-activation whose response was lost restores the point from before it', async ({ page }) => {
  const mock = new MockSignalK();
  try {
    const h = await setup(page, mock, 1);
    await openRouteEditor(page, h.points[3], ROUTE_NAME); // Next point B.

    // The server applies the re-activation (the course restarts at A), but
    // its response never arrives: the outcome is unknown to the app.
    await updateRouteButton(page).click();
    await (await heldRequest(h.updates, 0, 'route update PUT')).fulfill(COMPLETED);
    const activate = await heldRequest(h.activates, 0, 're-activation PUT');
    await h.setCourse(0);
    await activate.abort('connectionreset');
    await expect(page.getByText(/Failed to fetch/)).toBeVisible();
    await expect(updateRouteButton(page)).toBeEnabled();

    // The retry re-anchors on B, not on the restarted course's A.
    await saveUnchanged(page, h, 1);
    await expect.poll(() => h.pointIndexPuts).toEqual([{ value: 1 }]);
    await expect(routeNameInput(page)).toHaveCount(0);
  } finally {
    await mock.stop();
  }
});
