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
//! the `Update` wire type below. The `signalk` crate's own delta-application path never
//! threads this through to stored values at all (confirmed by reading
//! `V1Vessel::apply_update`/`update` in the cached crate source: only
//! `value.value` — the bare value — is passed down, never `update.source`).
//! So for delta-driven WS state, that metadata was structurally unavailable,
//! not merely discarded by incomplete extraction. We capture `$source` per
//! navigation leaf here (`*_source` fields below) so it's no longer lost —
//! kept internal for now since there's no UI/diagnostics consumer asking for
//! it yet (same "don't implement speculatively" rule as the deferred
//! `V1FullFormat.sources`/full-snapshot support below).

use serde::de::IgnoredAny;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value as Json;
use serde_json::value::RawValue;
use std::borrow::Cow;
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
// The `unsafe` clippy sees is wasm-bindgen's generated getter/setter glue,
// not hand-written code; the serde derive does not interact with it.
#[allow(clippy::unsafe_derive_deserialize)]
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
// See `Position`: wasm-bindgen glue, not hand-written `unsafe`.
#[allow(clippy::unsafe_derive_deserialize)]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VesselState {
    pub position: Option<Position>,
    pub cog: Option<f64>,     // Course over ground, radians
    pub sog: Option<f64>,     // Speed over ground, m/s
    pub heading: Option<f64>, // True heading, radians
    /// Active course/route state. Non-pub so `wasm_bindgen` ignores it;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sk_cpa: Option<SkClosestApproach>,
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
    /// Serialized unconditionally: `None` becomes an explicit `null` so the JS
    /// side can distinguish "server retracted the CPA" from "field not present"
    /// (its coldMap merge retains previous values for absent fields).
    pub sk_cpa: Option<SkClosestApproach>,
}

/// CPA data published by a Signal K plugin (e.g. `signalk-derived-data`,
/// `signalk-ais-target-prioritizer`) on `navigation.closestApproach`.
/// Only the two SK-spec-canonical fields are captured; plugin-specific
/// extensions (collisionRiskRating, collisionAlarmState, etc.) are ignored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkClosestApproach {
    /// Closest point of approach distance, metres.
    #[serde(rename = "distanceM")]
    pub distance_m: f64,
    /// Time to closest point of approach, seconds.
    #[serde(rename = "timeToS")]
    pub time_to_s: f64,
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
    closest_approach: Option<SkClosestApproach>,
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
    /// Record the own-vessel context.
    ///
    /// Every accumulated vessel is relative to a self: a *different* self means
    /// a different server (e.g. the user changed the Signal K URL and the
    /// client was reused via `reconnect()`), so the previous server's vessels —
    /// including its own vessel, which would otherwise surface as an AIS
    /// target — are discarded. The same self (a dropped link to the same
    /// server) keeps everything.
    pub fn set_self(&mut self, context: &str) {
        let id = strip_vessels_prefix(context);
        if self.self_id.as_deref().is_some_and(|old| old != id) {
            self.vessels.clear();
        }
        self.self_id = Some(id.to_string());
    }

    /// Return the stripped own-vessel id (without the `vessels.` prefix), if known.
    pub fn self_id(&self) -> Option<&str> {
        self.self_id.as_deref()
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
    let mut parts = id.split(':');
    match (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) {
        (Some("urn"), Some("mrn"), Some("imo"), Some("mmsi"), Some(mmsi)) => Some(mmsi.to_string()),
        _ => None,
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
    ClosestApproach,
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
    "navigation.closestApproach" => LeafKind::ClosestApproach,
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
            if let Ok(p) = Position::deserialize(value) {
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
            if let Some(s) = str_from_value(value)
                && let Some(ms) = parse_iso8601_utc_ms(&s)
            {
                vessel.nav.datetime_ms = Some(ms);
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
        LeafKind::ClosestApproach => {
            if value.is_null() {
                vessel.nav.closest_approach = None;
            } else {
                // SK sends the leaf as a bare object {distance, timeTo} or null.
                // The `signalk-ais-target-prioritizer` plugin adds extra fields
                // (collisionRiskRating etc.) which we safely ignore.
                let dist = value.get("distance").and_then(Json::as_f64);
                let time_to = value.get("timeTo").and_then(Json::as_f64);
                if let (Some(d), Some(t)) = (dist, time_to)
                    && d.is_finite()
                    && t.is_finite()
                {
                    vessel.nav.closest_approach = Some(SkClosestApproach {
                        distance_m: d,
                        time_to_s: t,
                    });
                }
            }
        }
    }
}

fn course_point_from_value(value: &Json) -> Option<CoursePoint> {
    let p = Position::deserialize(value.get("position")?).ok()?;
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
// Wire envelope (Hello / Delta).
// ---------------------------------------------------------------------------

/// Never-failing wrapper: `Some(T)` when the JSON value has `T`'s shape,
/// `None` when it doesn't or the key is absent. Lets one malformed piece of a
/// message be skipped without rejecting its well-formed siblings.
///
/// Captures the value as a [`RawValue`] first, so it only works under a
/// `serde_json` text deserializer (not untagged/flatten buffering).
struct Lenient<T>(Option<T>);

impl<T> Default for Lenient<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <&'de RawValue>::deserialize(deserializer)?;
        Ok(Self(serde_json::from_str(raw.get()).ok()))
    }
}

/// A JSON string, borrowed from the message text when it has no escapes and
/// decoded into an owned `String` otherwise.
#[derive(Deserialize)]
#[serde(transparent)]
struct Text<'a>(#[serde(borrow)] Cow<'a, str>);

/// One Signal K stream message. Delta (`context` + `updates`) and Hello
/// (`self`) share one struct rather than an untagged enum: untagged buffering
/// can't carry [`RawValue`], and the Delta-vs-Hello rule lives in
/// [`apply_message`].
#[derive(Deserialize)]
struct Message<'a> {
    #[serde(borrow, default)]
    context: Lenient<Text<'a>>,
    #[serde(borrow, default)]
    updates: Lenient<Vec<Lenient<Update<'a>>>>,
    #[serde(borrow, default, rename = "self")]
    self_: Lenient<Text<'a>>,
    /// Only its presence matters: a `vessels` key marks a Full snapshot.
    #[serde(default)]
    vessels: Lenient<IgnoredAny>,
}

/// One update block; `$source` applies to every value in it.
#[derive(Deserialize)]
struct Update<'a> {
    #[serde(borrow, default, rename = "$source")]
    source: Lenient<Text<'a>>,
    #[serde(borrow, default)]
    values: Lenient<Vec<Lenient<PathValue<'a>>>>,
}

#[derive(Deserialize)]
struct PathValue<'a> {
    #[serde(borrow)]
    path: Cow<'a, str>,
    /// The only genuinely polymorphic part of the envelope: its shape depends
    /// on `path`, so it's dispatched by [`apply_leaf`].
    value: Json,
}

// ---------------------------------------------------------------------------
// Message application.
// ---------------------------------------------------------------------------

/// Applies one incoming WebSocket text message (Hello or Delta) to `storage`.
///
/// Returns an error only for text that isn't valid JSON at all. A
/// syntactically valid message that isn't a recognised Hello/Delta shape — or
/// individual updates/leaf entries that are malformed — are silently ignored,
/// matching Signal K's "be lenient about what you don't understand" model;
/// one bad entry in an otherwise-good stream should never stop processing the
/// rest.
///
/// Full snapshots are intentionally unhandled: this client always connects
/// via `subscribe`, never requests `?full`, so a Full message is never
/// expected in practice. If one arrives anyway, storage is left untouched
/// (not reset) — there is nothing to parse it into, and silently discarding
/// otherwise-good retained state would be worse than ignoring the message.
pub fn apply_message(storage: &mut Storage, json: &str) -> crate::Result<Option<String>> {
    let raw: &RawValue =
        serde_json::from_str(json).map_err(crate::Error::json("Signal K message"))?;
    // Only an object can be a Hello/Delta. Without this guard serde would
    // also accept the positional (array) form of `Message`.
    if !raw.get().trim_start().starts_with('{') {
        return Ok(None);
    }
    // The text is valid JSON and every field is `Lenient`, so this only fails
    // on a duplicated envelope key — an unrecognised shape, ignored.
    let Ok(message) = serde_json::from_str::<Message>(raw.get()) else {
        return Ok(None);
    };

    if let Some(updates) = message.updates.0 {
        let Some(Text(context)) = message.context.0 else {
            return Ok(None);
        };
        // Infer self_ from the first delta's context if not yet set by Hello.
        // A proper Hello will already have set it; this is defensive-only.
        if storage.self_id.is_none() && context.starts_with("vessels.") {
            storage.set_self(&context);
        }
        let vessel = storage.vessel_mut(strip_vessels_prefix(&context));
        for update in updates.into_iter().filter_map(|u| u.0) {
            let source = update.source.0.as_ref().map(|Text(s)| &**s);
            for entry in update.values.0.into_iter().flatten().filter_map(|e| e.0) {
                apply_leaf(vessel, &entry.path, &entry.value, source);
            }
        }
        return Ok(Some(context.into_owned()));
    }
    if message.vessels.0.is_none()
        && let Some(Text(self_)) = message.self_.0
    {
        storage.set_self(&self_);
    }
    // Anything else (a Full snapshot, or an unrecognised shape) — see doc comment above.
    Ok(None)
}

// ---------------------------------------------------------------------------
// Datetime parsing.
// ---------------------------------------------------------------------------

/// Parse a UTC ISO 8601 datetime string to epoch milliseconds.
///
/// Handles the Signal K subset: `YYYY-MM-DDTHH:MM:SS[.frac]Z` (RFC 3339
/// `date-time` with fixed-width, unsigned digit fields).
/// Only UTC (`Z` suffix) is accepted — Signal K always uses UTC.
/// Returns `None` on any parse failure, including out-of-range fields
/// (month 13, Feb 30, hour 24, …) — those must not roll over into another
/// instant. A leap second (`:60`) is accepted and folds onto the next second,
/// as POSIX time does.
fn parse_iso8601_utc_ms(s: &str) -> Option<f64> {
    let s = s.trim().strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut dp = date.split('-');
    let year = fixed_width_digits(dp.next()?, 4)?;
    let month = fixed_width_digits(dp.next()?, 2)?;
    let day = fixed_width_digits(dp.next()?, 2)?;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    let (hms, frac_str) = time.split_once('.').unwrap_or((time, "0"));
    let mut tp = hms.split(':');
    let hour = fixed_width_digits(tp.next()?, 2)?;
    let min = fixed_width_digits(tp.next()?, 2)?;
    let sec = fixed_width_digits(tp.next()?, 2)?;
    if hour > 23 || min > 59 || sec > 60 {
        return None;
    }
    // Fraction: one or more ASCII digits (no sign, no other chars), truncated
    // to 3 digits and right-padded with zeros → milliseconds.
    if frac_str.is_empty() || !frac_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let frac3 = frac_str.get(..frac_str.len().min(3))?;
    let ms: i64 = format!("{frac3:0<3}").parse().ok()?;
    // All fields are bounded above (4-digit year), so this cannot overflow.
    let days = days_from_epoch(year, month, day);
    let (hour, min, sec) = (i64::from(hour), i64::from(min), i64::from(sec));
    Some((days * 86_400_000 + hour * 3_600_000 + min * 60_000 + sec * 1_000 + ms) as f64)
}

/// Parse a field of exactly `width` ASCII digits (no sign, no whitespace).
fn fixed_width_digits(s: &str, width: usize) -> Option<u32> {
    if s.len() != width || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Days in `month` (1–12) of the proleptic Gregorian `year`.
fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days from 1970-01-01 to the given Gregorian date (Hinnant's algorithm).
fn days_from_epoch(year: u32, month: u32, day: u32) -> i64 {
    let y = i64::from(year);
    let m = i64::from(month);
    let d = i64::from(day);
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
                sk_cpa: vessel.nav.closest_approach.clone(),
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

    let (rows, _) = hot.as_chunks_mut::<AIS_HOT_STRIDE>();
    for (slot, t) in rows.iter_mut().zip(targets) {
        let pos = t.position.unwrap_or(Position {
            longitude: f64::NAN,
            latitude: f64::NAN,
            altitude: None,
        });
        *slot = [
            pos.longitude,
            pos.latitude,
            t.cog.unwrap_or(f64::NAN),
            t.sog.unwrap_or(f64::NAN),
            t.heading.unwrap_or(f64::NAN),
            t.rot.unwrap_or(f64::NAN),
            (now_ms - t.last_position_update_ms) / 1000.0,
        ];
        cold.push(AisColdData {
            id: t.id.clone(),
            name: t.name,
            mmsi: t.mmsi,
            sk_cpa: t.sk_cpa.clone(),
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

/// Whether an AIS snapshot of `count` targets must be posted to the consumer,
/// given whether the previously posted snapshot was empty (`false` before the
/// first post, when the consumer's state is unknown).
///
/// The consumer replaces its whole AIS state with each snapshot, so the drop to
/// zero targets (last target pruned stale, server switch to one without AIS)
/// must be posted; only repeats of an already-posted empty snapshot are skipped.
pub fn ais_snapshot_due(count: usize, last_posted_empty: bool) -> bool {
    count > 0 || !last_posted_empty
}

/// Subscribe message for AIS targets (`vessels.*`).
///
/// The stream URL only carries `?subscribe=self`, so a non-self context
/// delivers exactly the paths listed here — a leaf `apply_leaf` handles for
/// AIS targets but missing from this list never arrives from a real server.
pub const AIS_SUBSCRIBE_MSG: &str = r#"{
    "context": "vessels.*",
    "subscribe": [
        {"path": "name",                            "period": 60000},
        {"path": "navigation.datetime",             "period": 1000},
        {"path": "navigation.position",             "period": 1000},
        {"path": "navigation.courseOverGroundTrue", "period": 1000},
        {"path": "navigation.speedOverGround",      "period": 1000},
        {"path": "navigation.headingTrue",          "period": 1000},
        {"path": "navigation.rateOfTurn",           "period": 1000},
        {"path": "navigation.speedThroughWater",    "period": 1000},
        {"path": "navigation.closestApproach",      "period": 1000}
    ]
}"#;

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::float_cmp
)]
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
        assert!(matches!(
            result,
            Err(crate::Error::Json {
                context: "Signal K message",
                ..
            })
        ));
    }

    #[test]
    fn valid_json_that_is_not_an_object_is_ignored() {
        let mut storage = Storage::default();
        // `["vessels.x", []]` is the positional form a derived struct would accept.
        for msg in [
            "[]",
            "42",
            r#""vessels.self""#,
            "null",
            r#"["vessels.x", []]"#,
        ] {
            let result = apply_message(&mut storage, msg);
            assert!(matches!(result, Ok(None)), "{msg}: {result:?}");
        }
        assert!(storage.self_id().is_none());
        assert!(storage.vessels.is_empty());
    }

    #[test]
    fn malformed_envelope_parts_are_skipped_not_fatal() {
        // Each malformed piece (non-object update, non-array values, entry
        // without `value`, non-string `path`, non-string `$source`) is skipped
        // individually; well-formed siblings in the same message still apply.
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        let ctx = apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:signalk:uuid:self",
            "updates": [
                7,
                {"$source": "a", "values": {"path": "navigation.speedOverGround", "value": 1.0}},
                {"$source": 5, "values": [
                    {"path": "navigation.speedOverGround"},
                    {"path": 1, "value": 2.0},
                    "junk",
                    {"path": "navigation.position", "value": {"longitude": 10.0, "latitude": 59.0}}
                ]}
            ]
        }"#,
        )
        .unwrap();
        assert_eq!(ctx.as_deref(), Some("vessels.urn:mrn:signalk:uuid:self"));
        let state = extract_vessel_state(&storage);
        assert_eq!(state.sog, None);
        assert_eq!(state.position, Some(Position::new(10.0, 59.0)));
        let vessel = &storage.vessels["urn:mrn:signalk:uuid:self"];
        assert_eq!(vessel.nav.position_source, None);
    }

    #[test]
    fn escaped_strings_in_envelope_are_decoded() {
        // JSON escapes can't be borrowed from the input; they must still be
        // decoded, not dropped.
        let mut storage = Storage::default();
        let ctx = apply_message(
            &mut storage,
            r#"{
            "context": "vessels.urn:mrn:signalk:uuid:s\u0065lf",
            "updates": [{"$source": "ws.\"quoted\"", "values": [
                {"path": "navigation.p\u006fsition", "value": {"longitude": 1.0, "latitude": 2.0}}
            ]}]
        }"#,
        )
        .unwrap();
        assert_eq!(ctx.as_deref(), Some("vessels.urn:mrn:signalk:uuid:self"));
        assert_eq!(storage.self_id(), Some("urn:mrn:signalk:uuid:self"));
        let vessel = &storage.vessels["urn:mrn:signalk:uuid:self"];
        assert_eq!(vessel.nav.position, Some(Position::new(1.0, 2.0)));
        assert_eq!(vessel.nav.position_source.as_deref(), Some("ws.\"quoted\""));
    }

    #[test]
    fn delta_without_context_is_ignored() {
        let mut storage = Storage::default();
        let ctx = apply_message(
            &mut storage,
            r#"{"updates": [{"values": [{"path": "navigation.speedOverGround", "value": 1.0}]}]}"#,
        )
        .unwrap();
        assert_eq!(ctx, None);
        assert!(storage.vessels.is_empty());
    }

    #[test]
    fn hello_requires_string_self_and_no_vessels_key() {
        let mut storage = Storage::default();
        apply_message(&mut storage, r#"{"self": 5}"#).unwrap();
        apply_message(&mut storage, r#"{"self": "vessels.a", "vessels": null}"#).unwrap();
        assert!(storage.self_id().is_none());
        apply_message(&mut storage, r#"{"version": "2.0.0", "self": "vessels.b"}"#).unwrap();
        assert_eq!(storage.self_id(), Some("b"));
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
    fn ais_snapshot_due_posts_non_empty_snapshots() {
        assert!(ais_snapshot_due(1, false));
        assert!(ais_snapshot_due(3, true));
    }

    #[test]
    fn ais_snapshot_due_posts_the_transition_to_empty() {
        // The consumer replaces its whole AIS state with each snapshot and has no
        // staleness handling of its own: if the drop to zero targets is never
        // posted, it keeps drawing the last non-empty snapshot forever.
        assert!(ais_snapshot_due(0, false));
    }

    #[test]
    fn ais_snapshot_due_suppresses_repeated_empty_snapshots() {
        assert!(!ais_snapshot_due(0, true));
    }

    #[test]
    fn last_target_going_stale_yields_a_due_empty_snapshot() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
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
        let stale_ms = 10.0 * 60.0 * 1000.0;

        // Fresh at 5 min: one target posted.
        let fresh = extract_ais_targets(&storage, 5.0 * 60.0 * 1000.0, stale_ms);
        assert_eq!(fresh.len(), 1);
        assert!(ais_snapshot_due(fresh.len(), false));

        // Stale at 20 min: the now-empty set must still reach the consumer.
        let now_ms = 20.0 * 60.0 * 1000.0;
        prune_stale_vessels(&mut storage, now_ms, stale_ms);
        let stale = extract_ais_targets(&storage, now_ms, stale_ms);
        assert!(stale.is_empty());
        assert!(ais_snapshot_due(stale.len(), fresh.is_empty()));
    }

    #[test]
    fn hello_from_a_different_self_discards_the_previous_servers_vessels() {
        // Changing the Signal K server URL reuses the client (and its Storage)
        // via `reconnect()`; the new server's Hello then names a different self.
        // Nothing accumulated from the old server may survive into AIS snapshots:
        // neither its AIS targets nor — worst of all — its own vessel, which is no
        // longer `self` and would otherwise render as a ghost AIS target.
        let mut storage = Storage::default();
        apply_message(
            &mut storage,
            r#"{"version": "2.0.0", "self": "vessels.urn:mrn:signalk:uuid:server-a"}"#,
        )
        .unwrap();
        for ctx in [
            "vessels.urn:mrn:signalk:uuid:server-a",
            "vessels.urn:mrn:imo:mmsi:111111111",
        ] {
            apply_message(
                &mut storage,
                &format!(
                    r#"{{"context": "{ctx}", "updates": [{{"values": [
                        {{"path": "navigation.position", "value": {{"longitude": 10.0, "latitude": 59.0}}}},
                        {{"path": "navigation.datetime", "value": "1970-01-01T00:04:00.000Z"}}
                    ]}}]}}"#
                ),
            )
            .unwrap();
        }

        apply_message(
            &mut storage,
            r#"{"version": "2.0.0", "self": "vessels.urn:mrn:signalk:uuid:server-b"}"#,
        )
        .unwrap();

        let now_ms = 5.0 * 60.0 * 1000.0;
        let targets = extract_ais_targets(&storage, now_ms, 10.0 * 60.0 * 1000.0);
        let ids: Vec<&str> = targets.iter().map(|t| t.id.as_str()).collect();
        assert!(
            ids.is_empty(),
            "previous server's vessels leaked into AIS targets: {ids:?}"
        );
    }

    #[test]
    fn hello_from_the_same_self_keeps_accumulated_vessels() {
        // A dropped link to the same server must keep its vessel data — that is
        // the whole point of `reconnect()` reusing the Storage.
        let hello = r#"{"version": "2.0.0", "self": "vessels.urn:mrn:signalk:uuid:server-a"}"#;
        let mut storage = Storage::default();
        apply_message(&mut storage, hello).unwrap();
        apply_message(
            &mut storage,
            r#"{"context": "vessels.urn:mrn:imo:mmsi:111111111", "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 10.0, "latitude": 59.0}},
                {"path": "navigation.datetime", "value": "1970-01-01T00:04:00.000Z"}
            ]}]}"#,
        )
        .unwrap();

        apply_message(&mut storage, hello).unwrap();

        let now_ms = 5.0 * 60.0 * 1000.0;
        let targets = extract_ais_targets(&storage, now_ms, 10.0 * 60.0 * 1000.0);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].id, "urn:mrn:imo:mmsi:111111111");
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
        assert!(
            storage
                .vessels
                .contains_key("urn:mrn:imo:mmsi:265813360:signalk-aisstream.XX")
        );
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
    fn parse_iso8601_multibyte_fraction_rejected_without_panic() {
        // Byte 3 of the fraction falls inside 'é' (bytes 2..4) — a byte slice
        // there would panic on untrusted network input.
        assert!(parse_iso8601_utc_ms("1970-01-01T00:00:01.12éZ").is_none());
        assert!(parse_iso8601_utc_ms("1970-01-01T00:00:01.1éZ").is_none());
    }

    #[test]
    fn parse_iso8601_non_digit_fraction_rejected() {
        // '€' is exactly 3 bytes, so the 3-byte slice succeeds but isn't digits.
        assert!(parse_iso8601_utc_ms("1970-01-01T00:00:00.€Z").is_none());
        assert!(parse_iso8601_utc_ms("1970-01-01T00:00:00.5aZ").is_none());
        // Truncates, never rounds: .9999 → 999 ms, not 1000.
        assert_eq!(
            parse_iso8601_utc_ms("1970-01-01T00:00:00.9999Z"),
            Some(999.0)
        );
    }

    #[test]
    fn parse_iso8601_out_of_range_components_rejected() {
        // Out-of-range fields must not silently roll over into another instant.
        for s in [
            "2024-00-15T00:00:00Z",
            "2024-13-01T00:00:00Z",
            "2024-01-00T00:00:00Z",
            "2024-01-32T00:00:00Z",
            "2023-02-29T00:00:00Z",
            "2024-04-31T00:00:00Z",
            "2024-01-01T24:00:00Z",
            "2024-01-01T25:00:00Z",
            "2024-01-01T00:60:00Z",
            "2024-01-01T00:00:61Z",
        ] {
            assert!(parse_iso8601_utc_ms(s).is_none(), "{s}");
        }
        // Valid calendar edges still parse.
        assert_eq!(
            parse_iso8601_utc_ms("2024-02-29T23:59:59.999Z"),
            Some(1_709_251_199_999.0)
        );
        // RFC 3339 leap second: POSIX time folds it onto the next second.
        assert_eq!(
            parse_iso8601_utc_ms("2016-12-31T23:59:60Z"),
            Some(1_483_228_800_000.0)
        );
    }

    #[test]
    fn parse_iso8601_signed_or_non_fixed_width_components_rejected() {
        for s in [
            "2024-01-01T00:-1:00Z",
            "2024-01-01T+1:00:00Z",
            "+2024-01-01T00:00:00Z",
            "2024-1-01T00:00:00Z",
            "2024-01-01T0:00:00Z",
            "1970-01-01T00:00:00.+5Z",
            "1970-01-01T00:00:00.-5Z",
            "1970-01-01T00:00:00.Z",
            "1970-01-01T00:00:00.1234aZ",
        ] {
            assert!(parse_iso8601_utc_ms(s).is_none(), "{s}");
        }
    }

    #[test]
    fn parse_iso8601_oversized_components_rejected_without_panic() {
        // Each of these overflowed i64 arithmetic (panic with overflow checks on).
        for s in [
            "2024-01-01T9223372036854775807:00:00Z",
            "2024-4294967295-01T00:00:00Z",
            "2147483647-01-01T00:00:00Z",
        ] {
            assert!(parse_iso8601_utc_ms(s).is_none(), "{s}");
        }
    }

    #[test]
    fn malformed_datetime_delta_keeps_previous_datetime() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        let ctx = "vessels.urn:mrn:imo:mmsi:230000001";
        let delta = |dt: &str| {
            format!(
                r#"{{"context":"{ctx}","updates":[{{"values":[{{"path":"navigation.datetime","value":"{dt}"}}]}}]}}"#
            )
        };
        apply_message(&mut storage, &delta("1970-01-01T00:04:00.000Z")).unwrap();
        for bad in ["1970-01-01T00:09:00.1€Z", "1970-01-01T00:09:00.€Z"] {
            assert!(
                apply_message(&mut storage, &delta(bad)).is_ok(),
                "malformed datetime {bad:?} must not fail the whole message"
            );
        }
        let vessel = storage.vessels.get("urn:mrn:imo:mmsi:230000001").unwrap();
        assert_eq!(vessel.nav.datetime_ms, Some(240_000.0));
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
            assert!(
                state
                    .course
                    .as_ref()
                    .and_then(|c| c.active_route.as_ref())
                    .is_some()
            );
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

    #[test]
    fn test_closest_approach_leaf() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        // Simulate an AIS vessel delta with navigation.closestApproach;
        // plugin adds extra fields (collisionRiskRating) which must be ignored.
        let delta = r#"{"context":"vessels.urn:mrn:imo:mmsi:123456789","updates":[{"$source":"sk-derived","values":[{"path":"navigation.position","value":{"latitude":60.1,"longitude":24.9}},{"path":"navigation.datetime","value":"2024-01-01T12:00:00.000Z"},{"path":"navigation.closestApproach","value":{"distance":500.0,"timeTo":300.0,"collisionRiskRating":0.85}}]}]}"#;
        apply_message(&mut storage, delta).unwrap();
        let targets = extract_ais_targets(&storage, 1704110400000.0 + 1000.0, 600_000.0);
        assert_eq!(targets.len(), 1);
        let sk_cpa = targets[0].sk_cpa.as_ref().expect("sk_cpa should be set");
        assert_eq!(sk_cpa.distance_m, 500.0);
        assert_eq!(sk_cpa.time_to_s, 300.0);
    }

    #[test]
    fn test_closest_approach_null_clears() {
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        let delta1 = r#"{"context":"vessels.urn:mrn:imo:mmsi:111111111","updates":[{"$source":"x","values":[{"path":"navigation.position","value":{"latitude":60.0,"longitude":25.0}},{"path":"navigation.datetime","value":"2024-01-01T12:00:00.000Z"},{"path":"navigation.closestApproach","value":{"distance":800.0,"timeTo":120.0}}]}]}"#;
        apply_message(&mut storage, delta1).unwrap();
        let delta2 = r#"{"context":"vessels.urn:mrn:imo:mmsi:111111111","updates":[{"$source":"x","values":[{"path":"navigation.closestApproach","value":null}]}]}"#;
        apply_message(&mut storage, delta2).unwrap();
        let targets = extract_ais_targets(&storage, 1704110400000.0 + 1000.0, 600_000.0);
        assert_eq!(targets.len(), 1);
        assert!(
            targets[0].sk_cpa.is_none(),
            "null delta should clear sk_cpa"
        );
    }

    #[test]
    fn test_cleared_sk_cpa_serializes_as_explicit_null() {
        // A CPA that the server retracted (null delta) must be observable by the
        // JS side: the cold-data entry must carry an explicit `"skCpa": null`,
        // not an absent field — absence is treated as "retain previous value"
        // by the app's coldMap merge.
        let mut storage = Storage::default();
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");
        let delta1 = r#"{"context":"vessels.urn:mrn:imo:mmsi:111111111","updates":[{"$source":"x","values":[{"path":"navigation.position","value":{"latitude":60.0,"longitude":25.0}},{"path":"navigation.datetime","value":"2024-01-01T12:00:00.000Z"},{"path":"navigation.closestApproach","value":{"distance":800.0,"timeTo":120.0}}]}]}"#;
        apply_message(&mut storage, delta1).unwrap();
        let delta2 = r#"{"context":"vessels.urn:mrn:imo:mmsi:111111111","updates":[{"$source":"x","values":[{"path":"navigation.closestApproach","value":null}]}]}"#;
        apply_message(&mut storage, delta2).unwrap();
        let targets = extract_ais_targets(&storage, 1704110400000.0 + 1000.0, 600_000.0);
        assert_eq!(targets.len(), 1);
        let t = &targets[0];
        // Mirror how `extract_ais_binary` builds the cold entry for this vessel.
        let cold = AisColdData {
            id: t.id.clone(),
            name: t.name.clone(),
            mmsi: t.mmsi.clone(),
            sk_cpa: t.sk_cpa.clone(),
        };
        let json = serde_json::to_string(&cold).unwrap();
        assert!(
            json.contains("\"skCpa\":null"),
            "cleared sk_cpa must serialize as an explicit null so the app can \
             distinguish retraction from absence, got: {json}"
        );
    }

    #[test]
    fn ais_subscription_requests_every_ais_leaf() {
        // With `?subscribe=self`, a `vessels.*` context only delivers the
        // subscribed paths. Every leaf `apply_leaf` stores for AIS targets must
        // therefore be subscribed — otherwise a real server never sends it.
        // `mmsi` is derived from the context id; `navigation.course*` is
        // own-vessel only (subscribed on `vessels.self`).
        let msg: Json = serde_json::from_str(AIS_SUBSCRIBE_MSG).unwrap();
        assert_eq!(msg["context"], "vessels.*");
        let subscribed: Vec<&str> = msg["subscribe"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["path"].as_str().unwrap())
            .collect();
        for (path, kind) in &LEAF_DISPATCH {
            let ais_leaf = !matches!(
                kind,
                LeafKind::Mmsi
                    | LeafKind::Course
                    | LeafKind::CourseNextPoint
                    | LeafKind::CoursePreviousPoint
                    | LeafKind::CourseActiveRoute
            );
            if ais_leaf {
                assert!(
                    subscribed.contains(path),
                    "AIS leaf `{path}` is dispatched but never subscribed on vessels.*"
                );
            }
        }
    }
}
