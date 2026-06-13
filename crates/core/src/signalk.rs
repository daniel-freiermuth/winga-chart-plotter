use serde::{Deserialize, Serialize};
use signalk::{SignalKStreamMessage, Storage};
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use js_sys::Float64Array;

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

/// Extract our chart-relevant fields from a `signalk::Storage` snapshot.
pub fn extract_vessel_state(storage: &Storage) -> VesselState {
    let Some(vessel) = storage.data().get_self() else {
        return VesselState::default();
    };
    let Some(nav) = &vessel.navigation else {
        return VesselState::default();
    };

    let position = nav
        .position
        .as_ref()
        .and_then(|p| p.value.as_ref())
        .map(|v| Position {
            longitude: v.longitude,
            latitude: v.latitude,
            altitude: v.altitude,
        });

    let course = extract_course(nav);

    VesselState {
        position,
        cog: nav.course_over_ground_true.as_ref().and_then(|v| v.value),
        sog: nav.speed_over_ground.as_ref().and_then(|v| v.value),
        heading: nav.heading_true.as_ref().and_then(|v| v.value),
        course,
    }
}

/// Extract course/route state from the navigation branch.
///
/// `V1CourseApi` and its nested types are private to the `signalk` crate, so
/// we access them exclusively through field paths and type inference (Rust
/// allows accessing pub fields of a value even when the type cannot be named
/// from outside the crate). String values (V1StringValue) are round-tripped
/// through JSON to extract their payload without naming the private enum.
fn extract_course(nav: &signalk::V1Navigation) -> Option<CourseState> {
    let c = nav.course.as_ref()?;

    // We cannot name V1StringValue directly (private module), so round-trip
    // through JSON to extract its string payload.
    fn to_str(v: &impl serde::Serialize) -> Option<String> {
        let j = serde_json::to_value(v).ok()?;
        match j {
            serde_json::Value::String(s) => Some(s),
            serde_json::Value::Object(ref o) => o.get("value")?.as_str().map(str::to_owned),
            _ => None,
        }
    }

    // Type is inferred from the field — we never name the private module.
    let next_point = c.next_point.as_ref().map(|np| CoursePoint {
        longitude: np.position.longitude,
        latitude: np.position.latitude,
    });

    let previous_point = c.previous_point.as_ref().map(|pp| CoursePoint {
        longitude: pp.position.longitude,
        latitude: pp.position.latitude,
    });

    let active_route = c.active_route.as_ref().and_then(|ar| {
        let href = to_str(&ar.href)?;
        let name = ar.name.as_ref().and_then(to_str);
        Some(ActiveRoute {
            href,
            name,
            point_index: ar.point_index,
            reverse: ar.reverse,
        })
    });

    Some(CourseState {
        next_point,
        previous_point,
        active_route,
    })
}

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

/// Extract non-self AIS targets that have a valid `navigation.datetime` and are not stale.
///
/// `now_ms`: current epoch ms (e.g. from `js_sys::Date::now()`).
/// `stale_ms`: drop vessels whose `navigation.datetime` is older than this many ms.
///
/// Vessels without a parseable `navigation.datetime` are silently skipped — in practice
/// this is only Class B transponders that never broadcast UTC time (very rare: 1/322 in
/// testing). It is also the correct behaviour for vessels with no position at all.
pub fn extract_ais_targets(storage: &Storage, now_ms: f64, stale_ms: f64) -> Vec<AisTarget> {
    let data = storage.data();
    // self_ is "vessels.urn:mrn:..." — the vessel map key is after "vessels."
    let self_key = data.self_.strip_prefix("vessels.").unwrap_or(&data.self_);

    let Some(vessels) = data.vessels.as_ref() else {
        return vec![];
    };

    vessels
        .iter()
        .filter(|(id, _)| id.as_str() != self_key)
        .filter_map(|(id, vessel)| {
            let nav = vessel.navigation.as_ref()?;
            // Parse the vessel's GPS clock to epoch ms. V1DateTime::get_value() is private
            // so we extract the string by serialising to JSON and matching the known shapes:
            // plain string → "\"YYYY-...\""  or  object → "{\"value\":\"YYYY-...\",...}".
            let last_ms = nav.datetime.as_ref().and_then(|dt| {
                let json = serde_json::to_string(dt).ok()?;
                // Strip outer quotes for the String variant, or extract "value" for Object.
                let s = if json.starts_with('"') {
                    serde_json::from_str::<String>(&json).ok()?
                } else {
                    serde_json::from_str::<serde_json::Value>(&json)
                        .ok()?
                        .get("value")?
                        .as_str()?
                        .to_owned()
                };
                parse_iso8601_utc_ms(&s)
            })?;
            // Drop stale targets.
            if now_ms - last_ms > stale_ms {
                return None;
            }
            let pos_value = nav.position.as_ref()?.value.as_ref()?;
            // Reject non-finite positions — corrupt AIS messages can produce NaN coords.
            if !pos_value.longitude.is_finite() || !pos_value.latitude.is_finite() {
                return None;
            }
            let position = Position {
                longitude: pos_value.longitude,
                latitude: pos_value.latitude,
                altitude: pos_value.altitude,
            };
            // AIS heading sentinel: 511° (not available). Signal K stores in radians,
            // so 511° ≈ 8.92 rad — clearly outside the valid [0, 2π) range.
            // COG sentinel: 360.0° (3600 in AIS 0.1° units) → 2π rad exactly.
            // Reject anything outside [0, 2π) to suppress both sentinels.
            let heading = nav
                .heading_true
                .as_ref()
                .and_then(|v| v.value)
                .filter(|&h| (0.0..std::f64::consts::TAU).contains(&h));
            let cog = nav
                .course_over_ground_true
                .as_ref()
                .and_then(|v| v.value)
                .filter(|&c| (0.0..std::f64::consts::TAU).contains(&c));
            Some(AisTarget {
                id: id.clone(),
                mmsi: vessel.mmsi.clone(),
                name: vessel.name.clone(),
                position: Some(position),
                cog,
                sog: nav
                    .speed_over_ground
                    .as_ref()
                    .and_then(|v| v.value)
                    .filter(|v| v.is_finite()),
                heading,
                rot: nav
                    .rate_of_turn
                    .as_ref()
                    .and_then(|v| v.value)
                    .filter(|v| v.is_finite()),
                stw: nav
                    .speed_through_water
                    .as_ref()
                    .and_then(|v| v.value)
                    .filter(|v| v.is_finite()),
                last_position_update_ms: last_ms,
            })
        })
        .collect()
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
    let data = storage.data();
    let self_key = data.self_.strip_prefix("vessels.").unwrap_or(&data.self_);

    let Some(vessels) = data.vessels.as_ref() else {
        return (Float64Array::new_with_length(0), vec![], vec![]);
    };

    struct Row {
        id: String,
        name: Option<String>,
        mmsi: Option<String>,
        lon: f64,
        lat: f64,
        cog: f64,
        sog: f64,
        hdg: f64,
        rot: f64,
        age: f64,
    }

    let rows: Vec<Row> = vessels
        .iter()
        .filter(|(id, _)| id.as_str() != self_key)
        .filter_map(|(id, vessel)| {
            let nav = vessel.navigation.as_ref()?;
            let last_ms = nav.datetime.as_ref().and_then(|dt| {
                let json = serde_json::to_string(dt).ok()?;
                let s = if json.starts_with('"') {
                    serde_json::from_str::<String>(&json).ok()?
                } else {
                    serde_json::from_str::<serde_json::Value>(&json)
                        .ok()?
                        .get("value")?
                        .as_str()?
                        .to_owned()
                };
                parse_iso8601_utc_ms(&s)
            })?;
            if now_ms - last_ms > stale_ms {
                return None;
            }
            let pos_value = nav.position.as_ref()?.value.as_ref()?;
            if !pos_value.longitude.is_finite() || !pos_value.latitude.is_finite() {
                return None;
            }
            let heading = nav
                .heading_true
                .as_ref()
                .and_then(|v| v.value)
                .filter(|&h| (0.0..std::f64::consts::TAU).contains(&h));
            let cog = nav
                .course_over_ground_true
                .as_ref()
                .and_then(|v| v.value)
                .filter(|&c| (0.0..std::f64::consts::TAU).contains(&c));
            Some(Row {
                id: id.clone(),
                name: vessel.name.clone(),
                mmsi: vessel.mmsi.clone(),
                lon: pos_value.longitude,
                lat: pos_value.latitude,
                cog: cog.unwrap_or(f64::NAN),
                sog: nav
                    .speed_over_ground
                    .as_ref()
                    .and_then(|v| v.value)
                    .filter(|v| v.is_finite())
                    .unwrap_or(f64::NAN),
                hdg: heading.unwrap_or(f64::NAN),
                rot: nav
                    .rate_of_turn
                    .as_ref()
                    .and_then(|v| v.value)
                    .unwrap_or(f64::NAN),
                age: (now_ms - last_ms) / 1000.0,
            })
        })
        .collect();

    let n = rows.len();
    let mut hot = vec![0.0f64; n * AIS_HOT_STRIDE];
    let mut ids = Vec::with_capacity(n);
    let mut cold = Vec::with_capacity(n);

    for (i, r) in rows.into_iter().enumerate() {
        let b = i * AIS_HOT_STRIDE;
        hot[b] = r.lon;
        hot[b + 1] = r.lat;
        hot[b + 2] = r.cog;
        hot[b + 3] = r.sog;
        hot[b + 4] = r.hdg;
        hot[b + 5] = r.rot;
        hot[b + 6] = r.age;
        cold.push(AisColdData {
            id: r.id.clone(),
            name: r.name,
            mmsi: r.mmsi,
        });
        ids.push(r.id);
    }

    (Float64Array::from(hot.as_slice()), ids, cold)
}

/// milliseconds relative to `now_ms`.
///
/// The `signalk` crate never evicts vessels from its internal HashMap, so without this
/// they accumulate indefinitely. This should be called periodically (e.g. at each AIS
/// emit tick) to bound memory usage.
///
/// Vessels that lack a parseable datetime are left in place — they will never appear
/// in AIS target snapshots but also don't consume significant memory.
pub fn prune_stale_vessels(storage: &mut Storage, now_ms: f64, stale_ms: f64) {
    let mut full = storage.get();
    let Some(vessels) = full.vessels.as_mut() else {
        return;
    };
    let before = vessels.len();
    vessels.retain(|_id, vessel| {
        let Some(nav) = vessel.navigation.as_ref() else {
            return true;
        };
        let Some(dt) = nav.datetime.as_ref() else {
            return true;
        };
        let json = match serde_json::to_string(dt) {
            Ok(j) => j,
            Err(_) => return true,
        };
        let s: Option<String> = if json.starts_with('"') {
            serde_json::from_str(&json).ok()
        } else {
            serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .and_then(|v| v.get("value").and_then(|v| v.as_str()).map(str::to_owned))
        };
        match s.and_then(|s| parse_iso8601_utc_ms(&s)) {
            Some(ms) => now_ms - ms <= stale_ms,
            None => true, // no parseable datetime → keep
        }
    });
    if vessels.len() < before {
        *storage = Storage::new(full);
    }
}

/// Returns an error string on JSON parse failure; unknown/bad messages are silently ignored.
pub fn apply_message(storage: &mut Storage, json: &str) -> Result<(), String> {
    let msg: SignalKStreamMessage =
        serde_json::from_str(json).map_err(|e| format!("JSON parse error: {e}"))?;
    match msg {
        SignalKStreamMessage::Full(full) => *storage = Storage::new(full),
        SignalKStreamMessage::Delta(delta) => {
            // If self_ is not yet set, infer it from the first delta's context.
            // A proper hello message will already have set it, but some servers
            // send deltas without a prior hello.
            if storage.data().self_.is_empty() {
                if let Some(ctx) = &delta.context {
                    if ctx.starts_with("vessels.") {
                        storage.set_self(ctx);
                    }
                }
            }
            storage.update(&delta);
        }
        SignalKStreamMessage::Hello(hello) => {
            if let Some(self_) = hello.self_ {
                storage.set_self(&self_);
            }
        }
        SignalKStreamMessage::BadData => {} // silently ignore unparseable messages
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use signalk::{Storage, V1FullFormat};

    fn make_storage_with_delta(delta: &str) -> Storage {
        let mut storage = Storage::new(V1FullFormat::default());
        apply_message(&mut storage, delta).unwrap();
        storage
    }

    #[test]
    fn parse_position_delta() {
        let mut storage = Storage::new(V1FullFormat::default());
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
        let mut storage = Storage::new(V1FullFormat::default());
        let result = apply_message(&mut storage, "not json");
        assert!(result.is_err());
    }

    #[test]
    fn ais_targets_exclude_self() {
        let mut storage = Storage::new(V1FullFormat::default());
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
        let pos = targets[0].position.unwrap();
        assert!((pos.longitude - 11.0).abs() < 1e-9);
        assert_eq!(targets[0].last_position_update_ms, 4.0 * 60.0 * 1000.0);
    }

    #[test]
    fn ais_targets_stale_dropped() {
        let mut storage = Storage::new(V1FullFormat::default());
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
        let mut storage = Storage::new(V1FullFormat::default());
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
        let mut storage = Storage::new(V1FullFormat::default());
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

        let vessels = storage.data().vessels.as_ref().unwrap();
        assert!(
            vessels.contains_key("urn:mrn:imo:mmsi:111111111"),
            "fresh vessel should remain"
        );
        assert!(
            !vessels.contains_key("urn:mrn:imo:mmsi:999999999"),
            "stale vessel should be pruned"
        );
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
}
