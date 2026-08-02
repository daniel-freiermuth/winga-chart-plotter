# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Split view: two independent chart panes. Drag the divider handle in from the right/bottom screen edge to open the second pane (it starts as a clone of the first); push it back to either screen edge to close — the pane at the far side of the divider stays fullscreen.

### Fixed

- The pinned vessel could end up outside the viewport after a drastic resize (window resize, orientation flip, split divider drag) — the pin is now re-anchored on every map resize.
- Map pitch (tilt) is now saved and restored across reloads, like center/zoom/bearing.
- Chart-picker thumbnails for charts crossing the antimeridian pointed at the wrong side of the planet; bounds containment and center now go through the WASM geo core.
- Vessels rendered hollow (outline only) under globe projection: deck.gl ≥9.3.3 enables backface culling for the whole globe view by default, and the custom vessel layers' fill triangles were wound clockwise. All vessel geometry is now normalized to counter-clockwise winding (pinned by a unit test across every geometry and morph blend), so globe culling works as designed and replaces the layers' in-shader far-hemisphere discard.
- Ruler and route-planner labels were invisible under globe projection — deck.gl's own text billboard quads fall to the same globe backface-culling default; the label layers now opt out of culling per layer (the overlay-wide opt-out stopped working in deck.gl 9.3.3).
- The compass button's free-rotation lock (long-press) is now also reachable by keyboard via Shift+Enter.
- The Settings toggles (Browser GPS, AIS track on click) now have accessible names for screen readers.

### Removed

- The "Show track" toggle in Settings → Own vessel; the same toggle lives in the chart picker's layer chips.
- The fullscreen toolbar button and its Fullscreen API integration — the installed PWA already launches fullscreen; in a browser tab the browser's own fullscreen (F11) still works.
- Plotter extensions can no longer move the map: `map.flyTo` and `map.fitBounds` in the extension host API are ignored (with a console warning). `map.getView` still works.

## [0.20.1] - 2026-07-30

### Fixed

- AIS vessels now show their selection ring at the dead-reckoned position when tapped there.
- AIS hitbox enlarged for easier tapping.
- Tapping a crowded area now shows a disambiguation menu that includes own vessel and waypoints.
- Route and AIS track antimeridian handling overhauled

## [0.20.0] - 2026-07-28

### Added

- Active route can now be edited while navigating.

### Fixed

- CPA calculations correct for vessels near the antimeridian.
- CPA approach/opening direction classified by initial range rate instead of the first sample, improving accuracy.
- CPA label popup no longer left stranded when CPA computation is bailed out.
- (browser-gps): CPA readout bounded to a 5 s staleness limit via an own-state refresh tick.
- Cleared Signal K CPA values now properly clear the UI.
- AIS target disambiguation keyed by stable vessel ID to prevent misidentification.
- Fresh installs default to a single base layer; migrated settings clamped to remove conflicts.
- Chart-picker previews unmount when scrolled out of view, preventing WebGL context exhaustion.
- Compass long-press timer cancelled when the pointer leaves the button.
- Widget arrange-mode idle timer released on component destroy.

## [0.19.1] - 2026-07-18

### Fixed

- Widget arrange mode no longer exits while a drag is still in progress.

## [0.19.0] - 2026-07-18

### Added

- Two-tap AIS information panel showing closest point of approach (CPA) to other vessels.
- Widgets are clickable and freely resizable.
- Chart picker closes automatically when a chart is selected.

## [0.18.1] - 2026-07-15

### Added

- Chart picker closes when clicking anywhere on the main map.
- Chart previews load lazily — faster initial chart picker open.
- Compass button visual polish.

## [0.18.0] - 2026-07-13

### Added

- Chart picker completely redesigned as a bottom pane with live previews; only one chart active at a time.
- Layer visibility controls moved into the chart/layer menu.
- Watercolor base map option.
- Charts sorted by most recently used.
- PWA launches in fullscreen mode.

### Changed

- Measurements and route drawing now start from the context menu (long-press / right-click on the chart) instead of a dedicated toolbar button.
- Rotation control and compass merged into a single combined control, relocated to the bottom-left alongside the pin control.

### Fixed

- Touch-to-pan made reliable.
- Route-point deletion restored on mobile.
- All other interactions blocked while a measurement or route is being drawn.

## [0.17.1] - 2026-07-04

### Fixed

- Widget data delivery broken by the own-vessel filter introduced in 0.16.1.
- Correct zoom slider direction; add a visual drag hint.

## [0.17.0] - 2026-07-03

### Added

- Vertical zoom slider.
- Map scale switches to metres at close range.
- Ruler snaps to the own vessel first, then to the nearest AIS target.

### Changed

- Panning the chart while the vessel is locked now updates the pinned position instead of being blocked.

### Fixed

- AIS popup opens at the vessel's actual position, not the click point.
- AIS track now terminates at the vessel, not short of it.
- Ruler popup closes on mousedown, consistent with other popups.
- Pointer events no longer handled by two overlapping layers simultaneously.

## [0.16.1] - 2026-07-03

### Fixed

- Routing mode now turns off properly when navigation stops.
- Draw the hull shape for AIS vessels that report COG but not heading.
- Prevent "timelapse" jump after returning to a backgrounded tab.
- Don't discard already-received Signal K data on WebSocket reconnection.
- Enforce a single WebSocket connection; drop duplicate connections.
- Scroll the chart list when it exceeds the viewport height.

## [0.16.0] - 2026-06-30

### Added

- Activate specific waypoints of a route directly, instead of only the next one.
- Morph AIS vessels seamlessly between icon and rendered shape.

### Changed

- Move geo-math computations into Rust/WASM.
- Replace the third-party `signalk` crate with a purpose-built parser — fixes a dispatch bug where `.accuracy` sibling paths would silently overwrite `courseOverGroundTrue`.
- Move Signal K API v2 handling into Rust/WASM.

### Fixed

- Persist follow-vessel lock, map rotation mode and projection choice across page reloads.
- Don't draw double lines for vessel states on icons.
- Don't elongate day symbols on vessel shapes.
- Show even very slow vessels in dead-reckoning.
- Adapt the settings panel to the available screen size.

## [0.15.0] - 2026-06-25

### Added

- Start the map at the last viewed position, falling back to the vessel's position.

### Fixed

- Don't subscribe to every vessel and path over the Signal K WebSocket — only what's displayed.
- Draw the active route, bearing line and own-vessel markers on top of AIS vessels.
- Make widgets usable when served over plain HTTP (non-secure context).

## [0.14.1] - 2026-06-15

### Changed

- Join chart offset and pinned-position state into a single type for type safety.

### Fixed

- Guard `onZoomEnd` against infinite loops.
- Avoid a MapLibre bug that triggered infinite recursion on zoom.
- Stop globe mode, pinned position and wheel-scroll from jarring the vessel's on-screen location.
- Load newly added chart layers in the currently active projection.

## [0.14.0] - 2026-06-14

### Added

- Support for plotter-extensions.

## [0.13.0] - 2026-06-14

### Changed

- Move the projection toggle button into the charts pane.

### Fixed

- Drop an accidentally committed zoom-debug layer.
- Don't unlock the chart after a ruler interaction.

## [0.12.1] - 2026-06-14

### Added

- Restored browser-location support (reverts the removal shipped in 0.12.0 — it broke more setups than it fixed).

### Fixed

- Pitch and zoom around the vessel correctly when position is locked, on touch screens.
- No sticky `:hover` state left behind on touch devices.
- Tweak line annotation rendering.

## [0.12.0] - 2026-06-13

### Added

- Honor `signalk-chart`'s tile URL for vector charts.
- Lock follow-vessel position until explicitly unlocked.
- Lock chart rotation until explicitly unlocked.
- Indicator for when the charts pane is open.
- Layer visibility control.

### Changed

- Disable double-click-to-zoom (conflicted with chart interaction).
- Show available charts immediately, without waiting on a round trip.
- Style locked chart rotation consistently with locked vessel position.
- Drop the redundant own-track display toggle.
- Optimize the settings commit flow.
- Reduce data uploaded to the GPU when a layer isn't needed.

### Removed

- **Breaking:** dropped support for browser-supplied geolocation (reverted in 0.12.1).

### Fixed

- Stop flickering on data reload.
- Draw dead-reckoning lines for exactly as long as the predictor horizon.
- Catch transient chart-loading errors instead of failing hard.
- Honor the fixed vessel position when rotating or pitching the map manually.
- Show at most one popup at a time.
- Fix own-track API requests.

## [0.11.4] - 2026-06-03

### Changed

- Nicer default colors.

### Fixed

- Incorrect license metadata published to npm.
- Render at full frame rate while actively interacting with the map.

## [0.11.3] - 2026-06-03

### Added

- Show Signal K connection status in the settings cogwheel.

### Changed

- Guard ruler snap-point calculation behind a cheaper pre-check.

### Fixed

- Force Firefox to keep delivering high-precision location updates continuously.

## [0.11.2] - 2026-06-02

### Fixed

- Don't change camera perspective when entering or leaving tracking view.
- Fix route segment text color.
- Hide the built-in MapLibre button.
- Show the route-editing HUD immediately instead of after a delay.

## [0.11.1] - 2026-06-02

### Fixed

- Correct Signal K auth scheme handling.

## [0.11.0] - 2026-06-01

### Added

- Show all routes on the chart, not just the active one.
- Login flow.
- "Navigate Here" button.
- Route stop action from the route popup.
- Button to activate a route.
- Route planner, including editing existing routes and route deletion.
- Waypoints support.
- Man Overboard (MOB) button with a custom swimmer icon and confirmation flow.
- "Follow Vessel" mode that locks the vessel into place.

### Changed

- Use `easeTo` instead of `jumpTo` for heading-based chart rotation, and smooth deceleration once compass heading stabilizes.
- Only show populated fields in the AIS popup.
- Consolidate the map toolbar into a single flex column; reorder buttons.
- Clean up click-handling logic.

### Fixed

- Really limit AIS animation to the configured frame rate.
- Draw the own vessel on top of AIS targets.
- Stabilize and center the rotation-mode button.
- MOB notifications: use the v1 REST API (v2 has no notifications endpoint), correct request body shape, and don't cancel on a second press.
- Remove an invalid `uniform` keyword inside the `layerUniforms` UBO that broke some GPUs.
- Redraw on COG (course-over-ground) change.
- Fix the vessel track API integration.

## [0.10.0] - 2026-05-31

### Added

- Own-vessel track recording and display.
- AIS target track fetching.
- BRG (bearing-up) chart rotation mode.
- "Keep screen on" option.
- Request a higher-quality GPS fix from the browser.

### Changed

- Ignore the active route's course when using the browser's own GPS.

### Fixed

- Draw routes crossing the antimeridian correctly, using great-circle segments.
- Improve browser-GPS performance by avoiding unnecessary updates; use `jumpTo` instead of `easeTo` for compass updates.

## [0.9.0] - 2026-05-30

### Added

- More advanced color picker.
- Borders for vessel polygons.
- Deep links into specific settings panels.

### Fixed

- Performance of browser-GPS-driven updates.

## [0.8.0] - 2026-05-29

### Changed

- Coalesce browser position updates for better performance.

## [0.7.0] - 2026-05-29

### Added

- Show the vessel's current route on the chart.
- Use compass heading from the browser as a fallback source.
- "About" section.

### Changed

- Delete a ruler via its popup instead of a small X control.
- Reorganize the settings panel.

## [0.6.0] - 2026-05-29

### Added

- Browser GPS toggle in settings.
- Show map scale in nautical miles.

### Fixed

- AIS icon no longer cross-fades when no hull polygon is drawn.
- MVT/S57 chart loading no longer fails permanently when the first style fetch fails.

## [0.5.0] - 2026-05-29

### Added

- North indicator compass shown whenever the map isn't North-up.

### Changed

- Narrow the AIS arrow icon; cap the dead-reckoning predictor to one full circle.

### Fixed

- Guard `style.load` handlers and set an explicit text font for AIS labels.
- Remap unsupported glyph fonts; force a service-worker update on deploy.
- Move the north indicator below the zoom controls.
- Disable MapLibre's `bearingSnap` (set to 0) so small heading changes aren't suppressed.

## [0.4.0] - 2026-05-28

### Added

- Auto-reconnect the Signal K WebSocket on disconnect or when the app returns from background.
- Support for S57/MVT vector charts.

### Changed

- Raise `maxPitch` to 85° for a flatter 3D view.

### Fixed

- Apply the vessel name from the REST API into the AIS "cold" map.
- Handle `{-y}` (TMS) tile URL schemes.
- Set the browser tab title to "Winga Chart Plotter".
- Make PWA manifest paths relative for subpath deployments.

## [0.3.0] - 2026-05-28

### Added

- Callsign, port, flag and air-height fields in vessel info.
- HF callsign and skipper name in vessel info.
- Navigational status in the AIS vessel-info popup.
- Live-updating age counter in the AIS popup.
- FPS configuration option.
- AIS decorations.
- Disambiguation popup when clicking overlapping AIS targets.
- Adaptive AIS icon border color.

### Fixed

- Apply the vessel name from the REST API into the AIS cold map.
- Reverted the signalk-aisstream ROT-plugin compensation workaround — it caused more problems than it solved.

## [0.2.1] - 2026-05-28

### Fixed

- Don't call `easeTo` during user interactions.
- Remove the built-in MapLibre compass button (superseded by the custom rotation-mode control).

## [0.2.0] - 2026-05-27

### Added

- Map rotation modes: North-up, COG, heading, bearing and manual, with a toggle button.

## [0.1.7] - 2026-05-27

### Changed

- Add `repository` field to `package.json` (npm packaging metadata).

## [0.1.6] - 2026-05-27

### Changed

- Isolate `maplibre-gl` into its own build chunk for better caching and load performance.

## [0.1.5] - 2026-05-27

### Changed

- Use `logo_with_border.png` for all app icons.

### Fixed

- Use a relative base path for Signal K webapp subpath mounting, restricted to production builds.
- Don't pass a `[1,0]` line-dasharray for solid lines.
- Add a character set to ruler `TextLayer`s so °, · and ✕ render correctly.

## [0.1.0] - 2026-05-26

Initial public groundwork: the first end-to-end pipeline from Signal K through the Rust/WASM core to a MapLibre-rendered chart with AIS overlays.

### Added

- First full data pipeline: Signal K connection and state handling moved into Rust/WASM.
- Configurable Signal K server connection, with error display.
- Heading, rhumb-line and great-circle line rendering.
- Switchable map projections.
- Support for the Signal K charts API, plus WMS/WMTS chart sources.
- AIS target rendering, including real-world vessel size, popups with extra vessel info, and timestamps.
- AIS cross-fade-free dead-reckoning animation.
- Links to external vessel-tracking platforms from the AIS popup.
- Adjustable AIS COG line length.
- "Fly to vessel" button; sticky follow-vessel mode; remembered chart layer selection.
- Fullscreen support and installable PWA (incl. offline app-shell service worker).
- Rulers for on-chart distance/bearing measurement.
- WebGL context-recovery handling.
- Signal K webapp packaging with automatic server URL detection.
- Zero-copy typed-array AIS data pipeline; AIS icons moved to the GPU.

### Changed

- AIS targets and overlays now render correctly in globe mode, including when zoomed out, rotated or tilted.
- Self-animating AIS layers, eliminating per-frame `setProps()` calls.
- Read zoom from the viewport during `draw()` instead of rebuilding layers on zoom change.
- Switched the deck.gl overlay to non-interleaved rendering mode for better performance; coalesced self-vessel position updates; throttled AIS label updates to 1Hz.

### Fixed

- Numerous early-stage fixes: vessel rendering across world copies, rhumb-line behavior near the poles, type-checking errors, premature `setProjection` calls, missing speed/heading updates, mobile map freezing, duplicate AIS popups, missing/incomplete AIS target data, ghost rendering for hull-less vessels, line-style handling, and Mercator-correct GPU point scaling.
