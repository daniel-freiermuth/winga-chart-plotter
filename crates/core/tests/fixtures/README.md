# Wire-delta fixtures

Used for Phase 1 parity testing: the same fixture is fed through the old
`signalk`-crate-based path (`crate::signalk`) and the new `skdata` path, and
the two `VesselState`/`AisTarget`/`CourseState` outputs must be identical
before the old crate dependency is removed.

| File | Provenance |
|---|---|
| `hello.json` | Real — captured from `wss://demo.signalk.org/signalk/v1/stream?subscribe=all`, 2026-06-29. |
| `self_nav_sequence.json` | Real — captured from the same session: four consecutive single-field self-vessel updates (speedOverGround, courseOverGroundTrue, headingTrue, position), as actually sent (one field per delta, not bundled). |
| `ais_bundled_update.json` | Real — captured from the same session: a multi-value AIS update bundling navigation fields with `sensors.ais.class`, `navigation.state`/`specialManeuver` (fields we don't model — must be silently ignored, not error), and a `"path": ""` entry that merges `{"mmsi": "..."}` at the vessel root (a real SignalK convention some AIS plugins use; both the old crate and `skdata` must tolerate it without crashing — mmsi for AIS targets is independently derived from the context URN, so this entry is a no-op rather than a feature either implementation needs to act on). |
| `accuracy_sibling_delta.json` | Real — the exact delta shape captured on a live boat (`ws.Disen.signalk-nav-provider`) during the original COG-flicker bug investigation; same literal radian values already embedded in `signalk.rs`'s `accuracy_sibling_does_not_clobber_course_over_ground_true` regression test. |
| `ais_with_datetime.json` | Synthetic-but-spec-verified. The demo server's AIS replay never sends `navigation.datetime` per-vessel (confirmed by scanning ~2,300 captured AIS deltas — zero matches), so no real example was capturable. Built from the real `ais_bundled_update.json` vessel context with `navigation.datetime` added in the exact wire shape confirmed against the `signalk` crate source (`V1DateTime`, `src/definitions.rs`): a bare ISO-8601 UTC string. |
| `course_destination_delta.json` | Synthetic-but-spec-verified. Triggering a real `navigation.course` delta requires a `PUT` to the v2 Course API, which the public demo server rejects with `401` (no anonymous write access). Built directly from the confirmed `V1CourseApi`/`V1CourseApiPointModel`/`V1CourseApiActiveRouteModel` struct definitions (`src/navigation_course.rs`) — exact field names/camelCase, leaf-path-per-entry (not a single bundled `navigation.course` object), matching how the crate's own recursive dispatch requires it to arrive. |
