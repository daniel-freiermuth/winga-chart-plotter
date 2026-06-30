//! Signal K v2 REST client — the typed Rust/WASM replacement for
//! `app/src/lib/signalk-api.ts`'s hand-written `fetch()` surface.
//!
//! Per ADR-009 Phase 2: ported 1:1, function-for-function, not generated
//! (typify/progenitor were both evaluated and rejected as not worth their
//! cost — see KNOWLEDGE_BASE.md). Each submodule mirrors one TS call-site
//! grouping (charts/routes/waypoints/course/notifications/history/vessel
//! info) and follows the same split as `geo.rs`: a pure, host-testable core
//! (URL building, JSON [de]serialisation) plus a thin `#[wasm_bindgen]`
//! async wrapper that performs the actual `fetch()` (WASM-only — see
//! `http.rs`).
//!
//! Auth-header construction stays on the TS side (token lifecycle is a
//! UI/session-state concern, not Signal K parsing) — callers pass a plain
//! JS object (`Record<string, string>`) across the boundary unchanged.

#[cfg(target_arch = "wasm32")]
mod http;

/// Serialize a Rust value to a plain JS object/array tree — Signal K REST
/// responses are `Record<string, T>` (plain objects), not ES2015 `Map`s, and
/// the TS call sites (`Object.entries(data)`, …) rely on that. The default
/// `serde_wasm_bindgen::to_value` serializes Rust maps as JS `Map`s, which
/// would silently break those call sites — use this for any `HashMap`-keyed
/// REST payload instead. (Genuine `Map` returns, e.g. `fetchVesselInfo`'s
/// `Map<string, VesselInfo>`, use plain `to_value` directly.)
pub fn to_js_object<T: serde::Serialize + ?Sized>(
    value: &T,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
}

pub mod charts;
pub mod course;
pub mod history;
pub mod notifications;
pub mod routes;
mod urlenc;
pub mod vessel_info;
pub mod waypoints;
