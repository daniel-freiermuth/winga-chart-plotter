//! Purpose-built replacement for the `signalk` crate's v1 data layer.
//!
//! Models only what this app actually consumes — navigation, minimal vessel
//! identity (mmsi/name), and the course API — instead of the full Signal K v1
//! spec (electrical/environment/propulsion/steering/design/performance/
//! communication). See `KNOWLEDGE_BASE.md` ADR-009.
//!
//! ## Why not the `signalk` crate
//!
//! Its delta dispatch (`Updatable::update`) matches a path by splitting on `.`
//! and switching on each remaining *first* segment only, recursing without
//! ever checking that the segment is the *last* one. A `"<leaf>.accuracy"`
//! sibling entry — a non-canonical but real convention some providers send —
//! therefore dispatches to the exact same setter as `"<leaf>"` itself, and
//! whichever entry comes last in the delta's `values` array silently wins.
//! Confirmed byte-for-byte on a live boat: `courseOverGroundTrue` flickering
//! between the real GPS course and its own `.accuracy` sibling's value.
//!
//! This module replaces recursive segment matching with one exact-full-path
//! lookup per delta entry (`LEAF_DISPATCH`, a `phf::Map`). A `.accuracy` (or
//! any other) suffix is then structurally not a key in the map — there is no
//! recursive matching left to mis-route it.
//!
//! ## Metadata
//!
//! Signal K's wire delta format places `$source`/`timestamp` at the *update
//! block* level (shared by every value in that block), not per-value — see
//! [`Update`] below. The `signalk` crate's own delta-application path never
//! threads this through to stored values at all (confirmed by reading
//! `V1Vessel::apply_update`/`update` in the cached crate source: only
//! `value.value` — the bare value — is passed down, never `update.source`).
//! So for delta-driven WS state, that metadata was structurally unavailable,
//! not merely discarded by incomplete extraction. We capture `$source` per
//! navigation leaf here (`*_source` fields below) so it's no longer lost —
//! kept internal for now since there's no UI/diagnostics consumer asking for
//! it yet (same "don't implement speculatively" rule as the deferred
//! `V1FullFormat.sources`/full-snapshot support below).

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use js_sys::Float64Array;

// ---------------------------------------------------------------------------
// Public types — identical shape to the types this module replaces, so
// nothing downstream of `extract_*`/`VesselState`/`Position`/`AisTarget`
// needs to change at cutover.
// ---------------------------------------------------------------------------

/// A geographic position with optional accuracy metadata.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub longitude: f64,
    pub latitude: f64,
    pub altitude: Option<f64>,
}

#[wasm_bindgen]
impl Position {
    #[wasm_bindgen(constructor)]
    pub fn new(longitude: f64, latitude: f64) -> Self {
        Self {
            longitude,
            latitude,
            altitude: None,
        }
    }
}

/// The active route's waypoint being navigated toward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CoursePoint {
    pub longitude: f64,
    pub latitude: f64,
}

/// Active route metadata (from `navigation.course.activeRoute`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRoute {
    /// REST href to the route resource, e.g. `/v1/api/resources/routes/{uuid}`.
    pub href: String,
    pub name: Option<String>,
    /// Index of the current target waypoint in the route's coordinate array.
    pub point_index: i64,
    pub reverse: bool,
}

/// Course/route state extracted from `navigation.course`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CourseState {
    pub next_point: Option<CoursePoint>,
    pub previous_point: Option<CoursePoint>,
    pub active_route: Option<ActiveRoute>,
}

/// Parsed Signal K self-vessel state relevant for chart display.
#[wasm_bindgen]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VesselState {
    pub position: Option<Position>,
    pub cog: Option<f64>,     // Course over ground, radians
    pub sog: Option<f64>,     // Speed over ground, m/s
    pub heading: Option<f64>, // True heading, radians
    /// Active course/route state. Non-pub so wasm_bindgen ignores it;
    /// included in serde serialisation for the JS state callback.
    #[serde(skip_serializing_if = "Option::is_none")]
    course: Option<CourseState>,
}

#[wasm_bindgen]
impl VesselState {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
}

/// An AIS target — another vessel tracked via Signal K.
///
/// Only vessels with a recorded receive time (in the `vessel_times` map passed to
/// `extract_ais_targets`) are ever emitted — vessels that have never been heard
/// from, or whose last update is stale, are silently dropped.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AisTarget {
    pub id: String,
    pub mmsi: Option<String>,
    pub name: Option<String>,
    pub position: Option<Position>,
    pub cog: Option<f64>,     // rad
    pub sog: Option<f64>,     // m/s
    pub heading: Option<f64>, // rad true
    pub rot: Option<f64>,     // rad/s, + = turning right
    pub stw: Option<f64>,     // speed through water, m/s
    /// Epoch ms of the last received position update (wall-clock time on receive).
    pub last_position_update_ms: f64,
}

/// Cold (non-positional) metadata for an AIS vessel, transmitted alongside the hot buffer.
///
/// Only fields available from the AIS stream itself are included here; additional fields
/// such as `shipType`, `lengthM`, `beamM`, and `draftM` are supplied by the REST API
/// enrichment path on the JS side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AisColdData {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mmsi: Option<String>,
}

/// Stride of the typed array produced by [`extract_ais_binary`]: 7 `f64` values per vessel.
pub const AIS_HOT_STRIDE: usize = 7;

// ---------------------------------------------------------------------------
// Internal storage model.
// ---------------------------------------------------------------------------

/// One vessel's retained navigation state.
#[derive(Debug, Clone, Default)]
struct Navigation {
    position: Option<Position>,
    position_source: Option<String>,
    cog: Option<f64>,
    cog_source: Option<String>,
    sog: Option<f64>,
    sog_source: Option<String>,
    heading: Option<f64>,
    heading_source: Option<String>,
    rate_of_turn: Option<f64>,
    speed_through_water: Option<f64>,
    /// Parsed eagerly on receipt so AIS staleness checks never re-parse the string.
    datetime_ms: Option<f64>,
    course: Option<CourseState>,
}

#[derive(Debug, Clone, Default)]
struct Vessel {
    mmsi: Option<String>,
    name: Option<String>,
    nav: Navigation,
}

/// Retained Signal K vessel state, built up from Hello + Delta stream messages.
///
/// Replaces `signalk::Storage`. Keyed by vessel id with the `"vessels."`
/// prefix stripped but every other `.` preserved — the `signalk` crate's own
/// `V1FullFormat::apply_delta` truncates ids at the *first* remaining dot
/// (`context.split('.').collect()` then takes only `v[1]`), which would
/// silently collide two vessels whose ids share a prefix before a dot (e.g.
/// a `.XX`-suffixed AIS-relay id). Preserving the full id avoids that.
#[derive(Debug, Default)]
pub struct Storage {
    self_id: Option<String>,
    vessels: HashMap<String, Vessel>,
}

impl Storage {
    pub fn set_self(&mut self, context: &str) {
        self.self_id = Some(strip_vessels_prefix(context).to_string());
    }

    fn vessel_mut(&mut self, id: &str) -> &mut Vessel {
        self.vessels
            .entry(id.to_string())
            .or_insert_with(|| Vessel {
                mmsi: mmsi_from_id(id),
                ..Default::default()
            })
    }
}

fn strip_vessels_prefix(context: &str) -> &str {
    context.strip_prefix("vessels.").unwrap_or(context)
}

/// Extracts the MMSI from a Signal K vessel id of the form
/// `urn:mrn:imo:mmsi:<mmsi>` (optionally with further `:`-separated suffix
/// segments, which are ignored).
fn mmsi_from_id(id: &str) -> Option<String> {
    let parts: Vec<&str> = id.split(':').collect();
    if parts.len() >= 5
        && parts[0] == "urn"
        && parts[1] == "mrn"
        && parts[2] == "imo"
        && parts[3] == "mmsi"
    {
        Some(parts[4].to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Exact-leaf-path dispatch.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeafKind {
    Mmsi,
    Name,
    Position,
    Cog,
    Sog,
    Heading,
    RateOfTurn,
    SpeedThroughWater,
    Datetime,
    /// Parent path — SK may send the whole `navigation.course` object at once.
    Course,
    CourseNextPoint,
    CoursePreviousPoint,
    CourseActiveRoute,
}

static LEAF_DISPATCH: phf::Map<&'static str, LeafKind> = phf::phf_map! {
    "mmsi" => LeafKind::Mmsi,
    "name" => LeafKind::Name,
    "navigation.position" => LeafKind::Position,
    "navigation.courseOverGroundTrue" => LeafKind::Cog,
    "navigation.speedOverGround" => LeafKind::Sog,
    "navigation.headingTrue" => LeafKind::Heading,
    "navigation.rateOfTurn" => LeafKind::RateOfTurn,
    "navigation.speedThroughWater" => LeafKind::SpeedThroughWater,
    "navigation.datetime" => LeafKind::Datetime,
    "navigation.course.nextPoint"    => LeafKind::CourseNextPoint,
    "navigation.course.previousPoint" => LeafKind::CoursePreviousPoint,
    "navigation.course.activeRoute"  => LeafKind::CourseActiveRoute,
    // Whole-object delivery — SK sends this when subscribed to the parent
    // `navigation.course` and any sub-field changes.
    "navigation.course"              => LeafKind::Course,
};

/// Extracts a string from a Signal K string-leaf value, which may arrive as
/// either a bare string or `{"value": "...", "$source": ..., ...}`.
fn str_from_value(v: &Json) -> Option<String> {
    match v {
        Json::String(s) => Some(s.clone()),
        Json::Object(o) => o.get("value")?.as_str().map(str::to_owned),
        _ => None,
    }
}

fn apply_leaf(vessel: &mut Vessel, path: &str, value: &Json, source: Option<&str>) {
    let Some(kind) = LEAF_DISPATCH.get(path) else {
        return; // Unknown path (including any `<leaf>.accuracy` sibling) — not a bug, just unmodeled.
    };
    match kind {
        LeafKind::Mmsi => {
            if let Some(s) = value.as_str() {
                vessel.mmsi = Some(s.to_string());
            }
        }
        LeafKind::Name => {
            if let Some(s) = value.as_str() {
                vessel.name = Some(s.to_string());
            }
        }
        LeafKind::Position => {
            if let Ok(p) = serde_json::from_value::<Position>(value.clone()) {
                vessel.nav.position = Some(p);
                vessel.nav.position_source = source.map(str::to_owned);
            }
        }
        LeafKind::Cog => {
            if let Some(v) = value.as_f64() {
                vessel.nav.cog = Some(v);
                vessel.nav.cog_source = source.map(str::to_owned);
            }
        }
        LeafKind::Sog => {
            if let Some(v) = value.as_f64() {
                vessel.nav.sog = Some(v);
                vessel.nav.sog_source = source.map(str::to_owned);
            }
        }
        LeafKind::Heading => {
            if let Some(v) = value.as_f64() {
                vessel.nav.heading = Some(v);
                vessel.nav.heading_source = source.map(str::to_owned);
            }
        }
        LeafKind::RateOfTurn => {
            if let Some(v) = value.as_f64() {
                vessel.nav.rate_of_turn = Some(v);
            }
        }
        LeafKind::SpeedThroughWater => {
            if let Some(v) = value.as_f64() {
                vessel.nav.speed_through_water = Some(v);
            }
        }
        LeafKind::Datetime => {
            // `navigation.datetime` arrives as either a bare ISO-8601 string
            // or `{"value": "...", ...}` — same shape as any string leaf.
            if let Some(s) = str_from_value(value) {
                if let Some(ms) = parse_iso8601_utc_ms(&s) {
                    vessel.nav.datetime_ms = Some(ms);
                }
            }
        }
        LeafKind::Course => {
            // SK may deliver the whole course object (or null) at once.
            if value.is_null() {
                // Server cleared the entire course.
                vessel.nav.course = None;
            } else if value.is_object() {
                // Merge each sub-field present in the object.
                let course = vessel.nav.course.get_or_insert_with(CourseState::default);
                if let Some(np) = value.get("nextPoint") {
                    course.next_point = if np.is_null() {
                        None
                    } else {
                        course_point_from_value(np)
                    };
                }
                if let Some(pp) = value.get("previousPoint") {
                    course.previous_point = if pp.is_null() {
                        None
                    } else {
                        course_point_from_value(pp)
                    };
                }
                if let Some(ar) = value.get("activeRoute") {
                    course.active_route = if ar.is_null() {
                        None
                    } else {
                        active_route_from_value(ar)
                    };
                }
                // If every sub-field is now None the course is effectively cleared.
                if course.next_point.is_none()
                    && course.previous_point.is_none()
                    && course.active_route.is_none()
                {
                    vessel.nav.course = None;
                }
            }
        }
        LeafKind::CourseNextPoint => {
            if value.is_null() {
                if let Some(course) = vessel.nav.course.as_mut() {
                    course.next_point = None;
                }
            } else if let Some(point) = course_point_from_value(value) {
                vessel
                    .nav
                    .course
                    .get_or_insert_with(CourseState::default)
                    .next_point = Some(point);
            }
        }
        LeafKind::CoursePreviousPoint => {
            if value.is_null() {
                if let Some(course) = vessel.nav.course.as_mut() {
                    course.previous_point = None;
                }
            } else if let Some(point) = course_point_from_value(value) {
                vessel
                    .nav
                    .course
                    .get_or_insert_with(CourseState::default)
                    .previous_point = Some(point);
            }
        }
        LeafKind::CourseActiveRoute => {
            if value.is_null() {
                if let Some(course) = vessel.nav.course.as_mut() {
                    course.active_route = None;
                }
            } else if let Some(route) = active_route_from_value(value) {
                vessel
                    .nav
                    .course
                    .get_or_insert_with(CourseState::default)
                    .active_route = Some(route);
            }
        }
    }
}

fn course_point_from_value(value: &Json) -> Option<CoursePoint> {
    let position = value.get("position")?;
    let p: Position = serde_json::from_value(position.clone()).ok()?;
    Some(CoursePoint {
        longitude: p.longitude,
        latitude: p.latitude,
    })
}

fn active_route_from_value(value: &Json) -> Option<ActiveRoute> {
    let href = value.get("href").and_then(str_from_value)?;
    let name = value.get("name").and_then(str_from_value);
    let point_index = value.get("pointIndex").and_then(Json::as_i64).unwrap_or(0);
    let reverse = value
        .get("reverse")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    Some(ActiveRoute {
        href,
        name,
        point_index,
        reverse,
    })
}

// ---------------------------------------------------------------------------
// Message application.
// ---------------------------------------------------------------------------

/// Applies one incoming WebSocket text message (Hello or Delta) to `storage`.
///
/// Returns an error only for text that isn't valid JSON at all. A
/// syntactically valid message that isn't a recognised Hello/Delta shape — or
/// individual leaf entries with malformed values — are silently ignored,
/// matching Signal K's "be lenient about what you don't understand" model;
/// one bad entry in an otherwise-good stream should never stop processing the
/// rest.
///
/// Full snapshots are intentionally unhandled: this client always connects
/// via `subscribe`, never requests `?full`, so a Full message is never
/// expected in practice. If one arrives anyway, storage is left untouched
/// (not reset) — there is nothing to parse it into, and silently discarding
/// otherwise-good retained state would be worse than ignoring the message.
pub fn apply_message(storage: &mut Storage, json: &str) -> Result<(), String> {
    let raw: Json = serde_json::from_str(json).map_err(|e| format!("JSON parse error: {e}"))?;
    let Some(obj) = raw.as_object() else {
        return Ok(());
    };

    if let Some(updates) = obj.get("updates").and_then(Json::as_array) {
        let context = obj.get("context").and_then(Json::as_str);
        // Infer self_ from the first delta's context if not yet set by Hello.
        // A proper Hello will already have set it; this is defensive-only.
        if storage.self_id.is_none() {
            if let Some(ctx) = context {
                if ctx.starts_with("vessels.") {
                    storage.set_self(ctx);
                }
            }
        }
        let Some(id) = context.map(strip_vessels_prefix) else {
            return Ok(());
        };
        let vessel = storage.vessel_mut(id);
        for update in updates {
            let source = update.get("$source").and_then(Json::as_str);
            let Some(values) = update.get("values").and_then(Json::as_array) else {
                continue;
            };
            for entry in values {
                let (Some(path), Some(value)) =
                    (entry.get("path").and_then(Json::as_str), entry.get("value"))
                else {
                    continue;
                };
                apply_leaf(vessel, path, value, source);
            }
        }
    } else if obj.contains_key("self") && !obj.contains_key("vessels") {
        if let Some(self_) = obj.get("self").and_then(Json::as_str) {
            storage.set_self(self_);
        }
    }
    // Anything else (a Full snapshot, or an unrecognised shape) — see doc comment above.
    Ok(())
}

// ---------------------------------------------------------------------------
// Datetime parsing.
// ---------------------------------------------------------------------------

/// Parse a UTC ISO 8601 datetime string to epoch milliseconds.
///
/// Handles the Signal K subset: `YYYY-MM-DDTHH:MM:SS[.frac]Z`.
/// Only UTC (`Z` suffix) is accepted — Signal K always uses UTC.
/// Returns `None` on any parse failure.
fn parse_iso8601_utc_ms(s: &str) -> Option<f64> {
    let s = s.trim().strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut dp = date.split('-');
    let year: i32 = dp.next()?.parse().ok()?;
    let month: u32 = dp.next()?.parse().ok()?;
    let day: u32 = dp.next()?.parse().ok()?;
    let (hms, frac_str) = time.split_once('.').unwrap_or((time, ""));
    let mut tp = hms.split(':');
    let hour: i64 = tp.next()?.parse().ok()?;
    let min: i64 = tp.next()?.parse().ok()?;
    let sec: i64 = tp.next()?.parse().ok()?;
    // Truncate fractional seconds to 3 digits, right-pad with zeros → milliseconds.
    let frac3 = &frac_str[..frac_str.len().min(3)];
    let ms: i64 = format!("{frac3:0<3}").parse().ok()?;
    let days = days_from_epoch(year, month, day);
    Some((days * 86_400_000 + hour * 3_600_000 + min * 60_000 + sec * 1_000 + ms) as f64)
}

/// Days from 1970-01-01 to the given Gregorian date (Hinnant's algorithm).
fn days_from_epoch(year: i32, month: u32, day: u32) -> i64 {
    let y = year as i64;
    let m = month as i64;
    let d = day as i64;
    let (y, m) = if m <= 2 { (y - 1, m + 12) } else { (y, m) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400; // year of era [0, 399]
    let doy = (153 * (m - 3) + 2) / 5 + d - 1; // day of year [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // day of era  [0, 146096]
    era * 146097 + doe - 719_468
}

// ---------------------------------------------------------------------------
// Extraction.
// ---------------------------------------------------------------------------

/// Extract our chart-relevant fields from `storage`'s self vessel.
pub fn extract_vessel_state(storage: &Storage) -> VesselState {
    let Some(self_id) = &storage.self_id else {
        return VesselState::default();
    };
    let Some(vessel) = storage.vessels.get(self_id) else {
        return VesselState::default();
    };
    VesselState {
        position: vessel.nav.position,
        cog: vessel.nav.cog,
        sog: vessel.nav.sog,
        heading: vessel.nav.heading,
        course: vessel.nav.course.clone(),
    }
}

/// Extract non-self AIS targets that have a valid `navigation.datetime` and are not stale.
///
/// `now_ms`: current epoch ms (e.g. from `js_sys::Date::now()`).
/// `stale_ms`: drop vessels whose `navigation.datetime` is older than this many ms.
///
/// Vessels without a parseable `navigation.datetime` are silently skipped — in practice
/// this is only Class B transponders that never broadcast UTC time (very rare: 1/322 in
/// testing). It is also the correct behaviour for vessels with no position at all.
pub fn extract_ais_targets(storage: &Storage, now_ms: f64, stale_ms: f64) -> Vec<AisTarget> {
    let self_id = storage.self_id.as_deref();
    storage
        .vessels
        .iter()
        .filter(|(id, _)| Some(id.as_str()) != self_id)
        .filter_map(|(id, vessel)| {
            let last_ms = vessel.nav.datetime_ms?;
            if now_ms - last_ms > stale_ms {
                return None;
            }
            let pos = vessel.nav.position?;
            // Reject non-finite positions — corrupt AIS messages can produce NaN coords.
            if !pos.longitude.is_finite() || !pos.latitude.is_finite() {
                return None;
            }
            // AIS heading sentinel: 511° (not available). Signal K stores in radians,
            // so 511° ≈ 8.92 rad — clearly outside the valid [0, 2π) range.
            // COG sentinel: 360.0° (3600 in AIS 0.1° units) → 2π rad exactly.
            // Reject anything outside [0, 2π) to suppress both sentinels.
            let heading = vessel
                .nav
                .heading
                .filter(|&h| (0.0..std::f64::consts::TAU).contains(&h));
            let cog = vessel
                .nav
                .cog
                .filter(|&c| (0.0..std::f64::consts::TAU).contains(&c));
            Some(AisTarget {
                id: id.clone(),
                mmsi: vessel.mmsi.clone(),
                name: vessel.name.clone(),
                position: Some(pos),
                cog,
                sog: vessel.nav.sog.filter(|v| v.is_finite()),
                heading,
                rot: vessel.nav.rate_of_turn.filter(|v| v.is_finite()),
                stw: vessel.nav.speed_through_water.filter(|v| v.is_finite()),
                last_position_update_ms: last_ms,
            })
        })
        .collect()
}

/// Like [`extract_ais_targets`] but returns data as a flat `Float64Array` for zero-copy
/// transfer via `postMessage([arrayBuffer])`, plus a parallel list of IDs and cold metadata.
///
/// Schema per vessel (stride = 7 × f64 = 56 bytes):
///
/// | offset | field           | sentinel      |
/// |--------|-----------------|---------------|
/// | 0      | longitude       | never NaN     |
/// | 1      | latitude        | never NaN     |
/// | 2      | cog (rad)       | NaN = unknown |
/// | 3      | sog (m/s)       | NaN = unknown |
/// | 4      | heading (rad)   | NaN = unknown |
/// | 5      | rot (rad/s)     | NaN = unknown |
/// | 6      | ageAtUpload\_s  | always finite |
///
/// `stw` (speed through water) is omitted; it is rarely used in chart display.
#[cfg(target_arch = "wasm32")]
pub fn extract_ais_binary(
    storage: &Storage,
    now_ms: f64,
    stale_ms: f64,
) -> (Float64Array, Vec<String>, Vec<AisColdData>) {
    let targets = extract_ais_targets(storage, now_ms, stale_ms);
    let n = targets.len();
    let mut hot = vec![0.0f64; n * AIS_HOT_STRIDE];
    let mut ids = Vec::with_capacity(n);
    let mut cold = Vec::with_capacity(n);

    for (i, t) in targets.into_iter().enumerate() {
        let b = i * AIS_HOT_STRIDE;
        let pos = t.position.unwrap_or(Position {
            longitude: f64::NAN,
            latitude: f64::NAN,
            altitude: None,
        });
        hot[b] = pos.longitude;
        hot[b + 1] = pos.latitude;
        hot[b + 2] = t.cog.unwrap_or(f64::NAN);
        hot[b + 3] = t.sog.unwrap_or(f64::NAN);
        hot[b + 4] = t.heading.unwrap_or(f64::NAN);
        hot[b + 5] = t.rot.unwrap_or(f64::NAN);
        hot[b + 6] = (now_ms - t.last_position_update_ms) / 1000.0;
        cold.push(AisColdData {
            id: t.id.clone(),
            name: t.name,
            mmsi: t.mmsi,
        });
        ids.push(t.id);
    }

    (Float64Array::from(hot.as_slice()), ids, cold)
}

/// Drop vessels whose `navigation.datetime` is more than `stale_ms` milliseconds
/// relative to `now_ms`.
///
/// This bounds memory usage — without it, vessels never seen again would
/// accumulate indefinitely. Call periodically (e.g. at each AIS emit tick).
///
/// Vessels that lack a parseable datetime are left in place — they will never appear
/// in AIS target snapshots but also don't consume significant memory.
pub fn prune_stale_vessels(storage: &mut Storage, now_ms: f64, stale_ms: f64) {
    storage
        .vessels
        .retain(|_id, vessel| match vessel.nav.datetime_ms {
            Some(ms) => now_ms - ms <= stale_ms,
            None => true, // no parseable datetime → keep
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_storage_with_delta(delta: &str) -> Storage {
        let mut storage = Storage::default();
        apply_message(&mut storage, delta).unwrap();
        storage
    }

    #[test]
    fn accuracy_sibling_does_not_clobber_course_over_ground_true() {
        // Reproduces the real-world delta shape from `ws.Disen.signalk-nav-provider`
        // (see `tests/fixtures/accuracy_sibling_delta.json` / `tests/fixtures/README.md`):
        // the accuracy entry comes *after* the value entry in the array, which is
        // exactly the ordering that let the upstream `signalk` crate's path dispatch
        // (matches only the first remaining segment) silently overwrite the real value.
        // With exact full-path dispatch, `.accuracy` is simply not a key in the map.
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:signalk:uuid:self",
            "updates": [{"values": [
                {"path": "navigation.courseOverGroundTrue", "value": 3.639211760122151},
                {"path": "navigation.courseOverGroundTrue.accuracy", "value": 1.166534199117212}
            ]}]
        }"#,
        )
        .unwrap();
        let state = extract_vessel_state(&storage);
        assert_eq!(state.cog, Some(3.639211760122151));
    }

    #[test]
    fn parse_position_delta() {
        let mut storage = Storage::default();
        // Pre-set self to a different vessel so this delta is treated as AIS.
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        apply_message(&mut storage, r#"{
            "context": "vessels.urn:mrn:signalk:uuid:test",
            "updates": [{"values": [{"path": "navigation.position", "value": {"longitude": 10.5, "latitude": 59.91}}]}]
        }"#).unwrap();
        let state = extract_vessel_state(&storage);
        // Self vessel has no position set — only the AIS target does.
        assert!(state.position.is_none());
    }

    #[test]
    fn ignore_unknown_paths() {
        let delta = r#"{
            "context": "vessels.urn:mrn:signalk:uuid:test",
            "updates": [{"values": [{"path": "unknown.path", "value": 42}]}]
        }"#;
        let storage = make_storage_with_delta(delta);
        let state = extract_vessel_state(&storage);
        assert!(state.position.is_none());
    }

    #[test]
    fn malformed_json_returns_error() {
        let mut storage = Storage::default();
        let result = apply_message(&mut storage, "not json");
        assert!(result.is_err());
    }

    #[test]
    fn ais_targets_exclude_self() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");

        apply_message(&mut storage, r#"{
            "context": "vessels.urn:mrn:signalk:uuid:self",
            "updates": [{"values": [{"path": "navigation.position", "value": {"longitude": 10.0, "latitude": 58.0}}]}]
        }"#).unwrap();

        // 4 minutes after epoch — within 10-minute staleness window.
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:imo:mmsi:123456789",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 11.0, "latitude": 59.0}},
                {"path": "navigation.datetime", "value": "1970-01-01T00:04:00.000Z"}
            ]}]
        }"#,
        )
        .unwrap();

        // now = 5 minutes after epoch
        let now_ms = 5.0 * 60.0 * 1000.0;
        let targets = extract_ais_targets(&storage, now_ms, 10.0 * 60.0 * 1000.0);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].id, "urn:mrn:imo:mmsi:123456789");
        assert_eq!(targets[0].mmsi, Some("123456789".to_string()));
        let pos = targets[0].position.unwrap();
        assert!((pos.longitude - 11.0).abs() < 1e-9);
        assert_eq!(targets[0].last_position_update_ms, 4.0 * 60.0 * 1000.0);
    }

    #[test]
    fn ais_targets_stale_dropped() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");

        // datetime = 9 minutes after epoch → stale when now = 20 minutes after epoch
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:imo:mmsi:999999999",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 11.0, "latitude": 59.0}},
                {"path": "navigation.datetime", "value": "1970-01-01T00:09:00.000Z"}
            ]}]
        }"#,
        )
        .unwrap();

        let now_ms = 20.0 * 60.0 * 1000.0;
        let targets = extract_ais_targets(&storage, now_ms, 10.0 * 60.0 * 1000.0);
        assert!(targets.is_empty(), "stale target should be dropped");
    }

    #[test]
    fn ais_target_without_datetime_dropped() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");

        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:imo:mmsi:111111111",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 11.0, "latitude": 59.0}}
            ]}]
        }"#,
        )
        .unwrap();

        let targets = extract_ais_targets(&storage, f64::INFINITY, 10.0 * 60.0 * 1000.0);
        assert!(
            targets.is_empty(),
            "vessel without datetime should be dropped"
        );
    }

    #[test]
    fn prune_stale_vessels_removes_old_entries() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");

        // Fresh vessel: datetime = 15 minutes after epoch
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:imo:mmsi:111111111",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 10.0, "latitude": 59.0}},
                {"path": "navigation.datetime", "value": "1970-01-01T00:15:00.000Z"}
            ]}]
        }"#,
        )
        .unwrap();

        // Stale vessel: datetime = 1 minute after epoch
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:imo:mmsi:999999999",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 11.0, "latitude": 59.0}},
                {"path": "navigation.datetime", "value": "1970-01-01T00:01:00.000Z"}
            ]}]
        }"#,
        )
        .unwrap();

        // now = 20 minutes, stale = 10 minutes → vessel at 1min is stale, vessel at 15min is fresh
        let now_ms = 20.0 * 60.0 * 1000.0;
        let stale_ms = 10.0 * 60.0 * 1000.0;
        prune_stale_vessels(&mut storage, now_ms, stale_ms);

        assert!(
            storage.vessels.contains_key("urn:mrn:imo:mmsi:111111111"),
            "fresh vessel should remain"
        );
        assert!(
            !storage.vessels.contains_key("urn:mrn:imo:mmsi:999999999"),
            "stale vessel should be pruned"
        );
    }

    #[test]
    fn vessel_id_with_extra_dots_is_not_truncated() {
        // The `signalk` crate's own `V1FullFormat::apply_delta` splits the whole
        // context on '.' and takes only the segment right after "vessels" — so an
        // id with a dotted suffix (a real shape: AIS-relay sources append
        // ".XX"-style suffixes) gets silently truncated, risking collisions between
        // vessels that share a prefix. We preserve the full id.
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:imo:mmsi:265813360:signalk-aisstream.XX",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 11.0, "latitude": 59.0}},
                {"path": "navigation.datetime", "value": "1970-01-01T00:01:00.000Z"}
            ]}]
        }"#,
        )
        .unwrap();
        assert!(storage
            .vessels
            .contains_key("urn:mrn:imo:mmsi:265813360:signalk-aisstream.XX"));
    }

    #[test]
    fn course_next_point_and_active_route_are_dispatched() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:signalk:uuid:self",
            "updates": [{"values": [
                {"path": "navigation.course.nextPoint", "value": {"position": {"latitude": 59.92, "longitude": 24.80}}},
                {"path": "navigation.course.activeRoute", "value": {"href": "/resources/routes/abc", "name": "Test Route", "pointIndex": 2, "reverse": false}}
            ]}]
        }"#,
        )
        .unwrap();
        let state = extract_vessel_state(&storage);
        let course = state.course.expect("course should be set");
        let next = course.next_point.as_ref().expect("nextPoint should be set");
        assert!((next.latitude - 59.92).abs() < 1e-9);
        assert!((next.longitude - 24.80).abs() < 1e-9);
        let route = course
            .active_route
            .as_ref()
            .expect("activeRoute should be set");
        assert_eq!(route.href, "/resources/routes/abc");
        assert_eq!(route.name, Some("Test Route".to_string()));
        assert_eq!(route.point_index, 2);
        assert!(!route.reverse);
    }

    #[test]
    fn bundled_ais_update_ignores_unmodeled_fields_and_empty_path() {
        // Real shape captured from a live SignalK server: bundles modeled navigation
        // fields alongside unmodeled ones (navigation.state, sensors.ais.class) and a
        // `"path": ""` entry that merges an object at the vessel root — a convention
        // some AIS plugins use that neither this nor the old crate implements; mmsi is
        // independently derived from the context URN, so this must be a silent no-op.
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:imo:mmsi:248071000",
            "updates": [{
                "$source": "n2k-sample-data.43",
                "timestamp": "2014-08-15T19:05:37.063Z",
                "values": [
                    {"path": "navigation.speedOverGround", "value": 7.2},
                    {"path": "navigation.courseOverGroundTrue", "value": 4.4541},
                    {"path": "navigation.position", "value": {"longitude": 24.8868133, "latitude": 59.8311633}},
                    {"path": "navigation.rateOfTurn", "value": 0},
                    {"path": "navigation.headingTrue", "value": 4.4854},
                    {"path": "navigation.state", "value": "motoring"},
                    {"path": "navigation.specialManeuver", "value": "not available"},
                    {"path": "", "value": {"mmsi": "248071000"}},
                    {"path": "sensors.ais.class", "value": "A"}
                ]
            }]
        }"#,
        )
        .unwrap();
        let vessel = storage.vessels.get("urn:mrn:imo:mmsi:248071000").unwrap();
        assert_eq!(vessel.nav.sog, Some(7.2));
        assert_eq!(vessel.nav.cog, Some(4.4541));
        assert!((vessel.nav.position.unwrap().longitude - 24.8868133).abs() < 1e-9);
        // mmsi comes from the context URN, not the empty-path merge.
        assert_eq!(vessel.mmsi, Some("248071000".to_string()));
    }

    #[test]
    fn parse_iso8601_epoch() {
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:00:00.000Z"), Some(0.0));
    }

    #[test]
    fn parse_iso8601_known_timestamp() {
        // 2023-11-14T22:13:20.000Z = 1700000000000 ms (well-known Unix timestamp)
        assert_eq!(
            parse_iso8601_utc_ms("2023-11-14T22:13:20.000Z"),
            Some(1_700_000_000_000.0)
        );
    }

    #[test]
    fn parse_iso8601_fractional_ms() {
        // 1 second + 500ms
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:00:01.5Z"), Some(1500.0));
        assert_eq!(
            parse_iso8601_utc_ms("1970-01-01T00:00:01.123Z"),
            Some(1123.0)
        );
        // microseconds truncated to ms
        assert_eq!(
            parse_iso8601_utc_ms("1970-01-01T00:00:01.123456Z"),
            Some(1123.0)
        );
    }

    #[test]
    fn parse_iso8601_no_fraction() {
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:01:00Z"), Some(60_000.0));
    }

    #[test]
    fn parse_iso8601_invalid() {
        assert!(parse_iso8601_utc_ms("not-a-date").is_none());
        assert!(parse_iso8601_utc_ms("").is_none());
        // non-UTC (no Z suffix) rejected
        assert!(parse_iso8601_utc_ms("2023-11-14T22:13:20+00:00").is_none());
    }

    #[test]
    fn course_null_clears_active_route_and_next_point() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        // First, activate a route.
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:signalk:uuid:self",
            "updates": [{"values": [
                {"path": "navigation.course.nextPoint",    "value": {"position": {"latitude": 59.9, "longitude": 24.8}}},
                {"path": "navigation.course.activeRoute",  "value": {"href": "/resources/routes/abc", "name": "R", "pointIndex": 0, "reverse": false}}
            ]}]
        }"#,
        )
        .unwrap();
        {
            let state = extract_vessel_state(&storage);
            assert!(
                state
                    .course
                    .as_ref()
                    .and_then(|c| c.active_route.as_ref())
                    .is_some(),
                "route should be set"
            );
        }
        // Now clear via sub-path nulls (what SK v2 course API sends).
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:signalk:uuid:self",
            "updates": [{"values": [
                {"path": "navigation.course.nextPoint",    "value": null},
                {"path": "navigation.course.activeRoute",  "value": null}
            ]}]
        }"#,
        )
        .unwrap();
        let state = extract_vessel_state(&storage);
        let course = state.course.as_ref();
        assert!(
            course.and_then(|c| c.active_route.as_ref()).is_none(),
            "active_route should be cleared by null delta"
        );
        assert!(
            course.and_then(|c| c.next_point.as_ref()).is_none(),
            "next_point should be cleared by null delta"
        );
    }

    #[test]
    fn course_parent_null_clears_entire_course() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:signalk:uuid:self",
            "updates": [{"values": [
                {"path": "navigation.course", "value": {"activeRoute": {"href": "/resources/routes/x", "pointIndex": 0, "reverse": false}}}
            ]}]
        }"#,
        )
        .unwrap();
        {
            let state = extract_vessel_state(&storage);
            assert!(state
                .course
                .as_ref()
                .and_then(|c| c.active_route.as_ref())
                .is_some());
        }
        // Null at the parent path clears everything.
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:signalk:uuid:self",
            "updates": [{"values": [
                {"path": "navigation.course", "value": null}
            ]}]
        }"#,
        )
        .unwrap();
        let state = extract_vessel_state(&storage);
        assert!(
            state.course.is_none(),
            "course should be None after parent-path null"
        );
    }

    #[test]
    fn course_parent_object_delivery() {
        // SK delivers `navigation.course` as a single object value (not sub-paths).
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:signalk:uuid:self",
            "updates": [{"values": [
                {"path": "navigation.course", "value": {
                    "nextPoint":    {"position": {"latitude": 60.1, "longitude": 25.0}},
                    "activeRoute":  {"href": "/resources/routes/y", "name": "R2", "pointIndex": 1, "reverse": true}
                }}
            ]}]
        }"#,
        )
        .unwrap();
        let state = extract_vessel_state(&storage);
        let course = state.course.as_ref().expect("course should be set");
        let next = course.next_point.as_ref().expect("nextPoint should be set");
        assert!((next.latitude - 60.1).abs() < 1e-9);
        let route = course
            .active_route
            .as_ref()
            .expect("activeRoute should be set");
        assert_eq!(route.href, "/resources/routes/y");
        assert_eq!(route.point_index, 1);
        assert!(route.reverse);
    }
}
