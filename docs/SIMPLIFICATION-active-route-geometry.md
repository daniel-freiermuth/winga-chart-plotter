# Simplification plan: derive the active route's geometry from the `routes` store

Status: **RFC — needs a human decision before any code changes** (see "Questions" at the end).
Verified against commit `180cd16`.

## What exists today

Two independent clients fetch the same route resource:

| | `route` store — `app/src/stores/route.svelte.ts` | `routes` store — `app/src/stores/routes.svelte.ts` |
|---|---|---|
| Fetches | one route, `GET` on the delta's `activeRoute.href` | all routes, `GET /signalk/v2/api/resources/routes` |
| HTTP / parsing | raw `fetch()` in TypeScript (`fetchRouteGeometry`, lines 41-85) | WASM `fetchAllRoutes` → `parse_route_record` (`crates/core/src/skrest/routes.rs:120,367`), 15 s timeout |
| Href forms | absolute `http…`, `/signalk/v2/api…`, `/signalk/v1/api…`, `/v1/api…`, bare `/resources/…` (lines 47-56) | n/a |
| Response shapes | SK envelope `.feature`, bare `Feature`, `FeatureCollection` (lines 71-81) | SK record `{uuid: {name, feature}}`; unparseable entries dropped |
| Stale guard | `_fetchGen` counter (lines 34-35, 88, 92, 96, 144, 160) | `createStaleGuardedResource` sequence + per-server base |
| Refreshes | only when the href changes, or when a caller calls `refreshGeometry()` | on server change (`App.svelte:572`), every `resourcePollIntervalSeconds` (`App.svelte:557`), after save (`App.svelte:66`) and delete (`Map.svelte:2057`) |
| Output | `route.geometry: Feature<LineString> \| null`, `route.loading`, `route.error` | `routes.entries: ServerRoute[]` with `uuid`, `geometry: Feature<LineString>` |

### Why the per-route client exists (history, verified with `git log`)

- `3145148` 2026-05-29 "feat: Show current route" — added `route.svelte.ts` and `fetchRouteGeometry`; no route collection existed yet.
- `793be41` 2026-05-31 "feat: show all routes" — added the collection.
- `915c010` 2026-06-30 "ref: Move APIv2 handling to Rust" — moved the collection to WASM; the per-route fetch was left in TypeScript.
- Fixes the per-route client has needed on its own since:
  `6f2d270` (2026-10-21) and `34e93b8` (2026-10-23) — drop the old server's in-flight geometry on a server switch;
  `b8a7c80` (2026-10-24) — `refreshGeometry()`, because a same-href edit of the active route is invisible to `update()`.

The original reason (no collection to look the route up in) is gone. The client also contradicts the repo rule
"no Signal K parsing in TypeScript" (`.github/copilot-instructions.md`).

## Payers today (repo-wide search for `fetchRouteGeometry|loadGeometry|refreshGeometry|_fetchGen|route.(geometry|loading|error)`)

Production:
- `route.geometry` — `app/src/components/Map.svelte:1940, 1944, 1977, 2643, 2858, 2862` (course line/bearing layers, waypoint markers, active-route popup "Edit route" / "Set as next waypoint").
- `route.loading`, `route.error` — **no production readers**.
- `route.refreshGeometry` — only `app/src/App.svelte:72`, called after `await routes.load(...)` at `App.svelte:66`, i.e. when the collection already holds the edited geometry.
- `RouteState` interface — only used inside `route.svelte.ts`.

Tests that pin the fetch path:
- `app/src/stores/route.svelte.test.ts:5-196` — href normalisation, response shapes, non-ok status, stale-response ordering
  (lines 12-68 are fetch-mock scaffolding; the `course()` helper and `route.clear()` in `beforeEach` stay with the metadata tests).
- `app/src/stores/route.test.ts:5-38` (`route.clear` with a fetch in flight) and `:125-149` (`route.refreshGeometry`).
- `e2e/tests/s7-reverse-route-next-waypoint.spec.ts:33` — the mock serves **only** the single-route endpoint
  `/signalk/v2/api/resources/routes/<uuid>`, not the collection. Under the new design its fixture must also (or instead)
  serve `/signalk/v2/api/resources/routes` as `{ <uuid>: resource }` — as
  `e2e/tests/s13-active-route-edit-reactivate-timeout.spec.ts:73-74` already does.

Survive unchanged: `route.svelte.test.ts:198-228` (course metadata), the `mirrorRouteIndex` / `reanchorPointIndex` tests in `route.test.ts`.

No persisted or serialized form carries `route.geometry`; it is in-memory only.

## Simpler design

`route.geometry` becomes a lookup into the store that already has the data; `activeUuid` already exists
(`route.svelte.ts:106`) and already keys the all-routes layer filter (`Map.svelte:2882`):

```ts
get geometry() {
  const id = this.activeUuid;
  return id ? routes.entries.find(r => r.uuid === id)?.geometry ?? null : null;
}
```

`Map.svelte:2003` already uses the same `routes.entries.find(r => r.uuid === uuid)` lookup (full-route distance in the all-routes popup).

### What would be deleted (production code only)

| Item | Location | Lines |
|---|---|---|
| `fetchRouteGeometry` (href normalisation, raw `fetch`, 3 response shapes) | `route.svelte.ts:37-85` | ~49 |
| `loadGeometry` | `route.svelte.ts:87-99` | ~13 |
| `_geometry`, `_loading`, `_error`, `_fetchGen` state | `route.svelte.ts:31-35` | 5 |
| `loading`, `error` in `RouteState` and their getters | `route.svelte.ts:21-22, 111-112` | 4 |
| geometry branch of `update()` (fetch / invalidate) | `route.svelte.ts:139-146` | ~8 (the href assignment stays) |
| `refreshGeometry` | `route.svelte.ts:150-157` | 8 |
| geometry/loading/error/gen handling in `clear()` | `route.svelte.ts:160-163` | ~2 |
| `refreshGeometry` call + comment | `App.svelte:71-72` | 2 |

Estimate: **~90 physical production lines removed (~65 excluding comments), ~5 added** (one `routes` import, the derived getter).
Header comment `route.svelte.ts:6-7` is rewritten to say the geometry is looked up in `routes`.

Concepts removed: a second HTTP client path, its 4 accepted href forms and 3 accepted response shapes, a stale-response
generation counter, the `loading`/`error` states nobody reads, and a refresh protocol callers must remember after editing the active route.

Tests on the same terms: ~190 test lines deleted (the fetch-path tests listed above); one test added — `route.geometry`
follows `routes.entries` by `activeUuid` (present, absent, after the active href changes); e2e fixture in `s7-reverse-route-next-waypoint.spec.ts` extended with the collection endpoint.

## What changes, and for whom

All differences are seen by users of the active-route rendering in `Map.svelte` (course line, waypoint markers, active-route popup).

1. **Edits from other UIs now appear.** The active geometry follows the routes poll, so an edit made in another Signal K
   client shows within `resourcePollIntervalSeconds` instead of never (until the href changes). A gain, but observable.
2. **Hrefs outside the collection stop rendering.** An `activeRoute.href` that is absolute (`http…`) to a different host, or a
   route that `GET /signalk/v2/api/resources/routes` on the configured server does not list, no longer gets a line.
   Today `fetchRouteGeometry` follows it. Note: signalk-server's Resources API aggregates all registered providers when listing
   without `?provider=` ([Resources API docs](https://demo.signalk.org/documentation/develop/rest-api/resources_api.html)),
   so provider-served routes on signalk-server are listed; other server implementations were not checked.
   Also, the uuid is the href's last path segment: an absolute href to another host whose uuid happens to match a local route
   would show the local route.
3. **Single-resource response shapes are no longer accepted.** Only what `parse_route_record` accepts per collection entry
   (`{name, feature: Feature<LineString>}`) renders; a server answering the single-route GET with a bare `Feature` or a
   `FeatureCollection` ("some plugins wrap it", `route.svelte.ts:75`) is irrelevant afterwards, but a server whose *collection*
   entries deviate would lose the active line too (it already loses the all-routes line today).
4. **After editing the active route, the map stops showing a stale copy.** Analysis assumes signalk-server's Course API
   (`src/api/course/index.ts` and `src/api/resources/index.ts`, master `1bbf190`); other course providers were not checked.
   - signalk-server already follows the edit. The route `PUT` (`updateRoute`, `App.svelte:51`) emits a
     `resources.routes.<uuid>` delta (resources `index.ts:1016-1024`, `buildDeltaMsg` `:1121-1137`). The Course API
     subscribes to `resources.routes.*` (course `index.ts:196-216`). Its `processResourceDeltas` (`:228-291`) matches the
     active href, re-reads the route (`getRoute`, `:1369-1383`), clamps `pointIndex` against it, recomputes `pointTotal`,
     `nextPoint` and `previousPoint` from the edited coordinates, and emits course deltas. The
     `activeRoute/pointIndex`/`nextPoint` handlers also re-read the route before applying an index (`:969-995`).
   - So once `updateRoute` succeeds, the server's course refers to the edited route, whether or not `activateRoute`
     (`App.svelte:70`) later succeeds, fails or times out.
   - **Today** `route.geometry` stays the pre-edit copy until `refreshGeometry` runs, which happens only after
     `activateRoute` resolves (`App.svelte:70-72`). In between, and permanently if re-activation fails (the scenario of
     `e2e/tests/s13-active-route-edit-reactivate-timeout.spec.ts`), the client is inconsistent with the server:
     - the course leg (`buildCourseLayers`, `Map.svelte:2858`) uses server `nextPoint`/`previousPoint` from the edited route,
       while the waypoint markers and next-waypoint highlight (`Map.svelte:2862-2870`) are drawn on pre-edit coordinates;
     - "Set as next waypoint" (`Map.svelte:1940-1942`) computes its index on pre-edit coordinates, and the server applies it
       to the edited route;
     - "Edit route" (`Map.svelte:1977-1980`) loads the pre-edit coordinates into the planner, so saving again reverts the
       server-side edit.
   - **With the lookup** the geometry switches to the edited route when `routes.load` completes (`App.svelte:66`), i.e. the
     same geometry the server resolves `pointIndex` against. The visible change is that markers, highlight, "Set as next
     waypoint" and "Edit route" follow the edit before (or without) a successful re-activation. Until re-anchoring runs, the
     server keeps the pre-edit `pointIndex` value and resolves `nextPoint` from it, clamped, on the edited route (course
     `index.ts:254-270`: the clamped index is local, `activeRoute.pointIndex` is not rewritten); the client highlights that
     same index on the same edited geometry. They differ only if the edit shortened the route below that index (the server
     clamps, `mirrorRouteIndex` does not); today, on the pre-edit geometry, they can differ after any edit.
5. **A route activated before the collection has it waits for the next poll.** The plan as written is a pure getter: it
   does **not** call `routes.load` when `activeUuid` is missing from `routes.entries`.
   - Today `update()` starts `loadGeometry` as soon as the href changes (`route.svelte.ts:137-142`), so the wait is one GET.
   - With the lookup, the wait depends on whether the collection already holds the route:
     - In-app activation is unaffected: it starts only from the all-routes popup (`Map.svelte:2037`), i.e. from a route
       already in `routes.entries`.
     - A route activated from startup or after a server switch waits for the initial `routes.load` (`App.svelte:572`), the
       same order of latency as today's GET. On a server switch the collection drops the old server's entries up front
       (`staleGuardedResource.svelte.ts:55-59`), so no old-server geometry can leak.
     - A route that **another client creates and activates** between two polls (another plotter, a plugin, a "navigate
       to" flow) is missing until the next `setInterval` tick (`App.svelte:552-560`). That is every
       `resourcePollIntervalSeconds` (default 5 s, `settings.svelte.ts:108`; any positive value, `Settings.svelte:183`).
   - Until it arrives:
     - `route-full` is not drawn (`buildCourseLayers`, `Map.svelte:2858`), and the waypoint markers fall back to the
       single next/previous points (`Map.svelte:2873-2876`);
     - "Edit route" is disabled with "Route geometry not yet loaded" (`canEdit`, `Map.svelte:1944,1955`).
   - A same-server failed poll keeps the last good list (`staleGuardedResource.svelte.ts:43,69-72`), so the line does not
     flicker on a transient error.
6. **The active route deleted under a running course loses its line.** signalk-server's `DELETE` emits a `null`
   `resources.routes.<id>` delta (resources `index.ts:1084-1089`). Course `processResourceDeltas` then gets `undefined`
   from `getRoute` (course `index.ts:246-249,1375-1377`) and does nothing, so the course stays active and
   `nextPoint`/`previousPoint` keep streaming.
   - Today the cached `_geometry` keeps rendering, because `update()` clears it only on an href change
     (`route.svelte.ts:137-139`).
   - With the lookup, the next poll drops the entry, and `route.geometry` becomes `null`. `route-full` and the per-point
     markers disappear, leaving the leg/bearing lines and the single next/previous markers (`Map.svelte:2858-2876`).
     "Edit route" becomes disabled.
   - Whether this is a gain (the map no longer shows a route that no longer exists, and "Edit route" can no longer
     re-create it) or a loss (the crew loses the route context of a still-active course) is a product call: Question 3.
7. Minor, not user-visible `[INFERENCE]`: collection coordinates are parsed to 2D (`routes.rs:83-92`), the raw fetch kept any
   altitude; all consumers cast coordinates to `[number, number]`.

## Questions the human must answer

1. Do any Signal K servers or route providers this project supports emit an `activeRoute.href` that is **not** listed by
   `GET /signalk/v2/api/resources/routes` on the configured server (absolute hrefs to another host, unlisted provider routes)?
   - **No** → delete the per-route client entirely as described.
   - **Yes** → keep a fallback; then the simplification only pays off if that fallback moves into WASM
     (`parse_route_record`-based single-route GET) rather than staying a TypeScript client — a different, larger change.
2. Do any course providers this project supports other than signalk-server's Course API keep resolving the active route
   against a pre-edit copy after the route resource is updated in place? Difference 4 is a fix only if the course provider
   re-reads the route on a resource update, as signalk-server does. If a supported provider does not, the derived geometry
   would run ahead of that provider's `nextPoint` after a failed re-activation, and the fix would need to be re-assessed for it.
3. Are differences 5 and 6 acceptable for a pure getter?
   - **Yes** → apply the plan as written.
   - **No for 5** → the implementation would also need to call `routes.load` when `activeUuid` changes to a uuid missing
     from `routes.entries` (one `$effect` in `App.svelte`). That brings back an on-change fetch trigger, though through
     the WASM collection path rather than a second client, and the production shrink drops by those few lines.
   - **No for 6** → the getter alone cannot keep a deleted route visible; keeping a last-known copy would bring back
     cached geometry state. That favours declining this proposal.
