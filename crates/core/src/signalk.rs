use serde::{Deserialize, Serialize};
use signalk::{SignalKStreamMessage, Storage};
use wasm_bindgen::prelude::*;

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
        Self { longitude, latitude, altitude: None }
    }
}

/// Parsed Signal K self-vessel state relevant for chart display.
#[wasm_bindgen]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VesselState {
    pub position: Option<Position>,
    pub cog: Option<f64>,     // Course over ground, radians
    pub sog: Option<f64>,     // Speed over ground, m/s
    pub heading: Option<f64>, // True heading, radians
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
    pub cog: Option<f64>,      // rad
    pub sog: Option<f64>,      // m/s
    pub heading: Option<f64>,  // rad true
    pub rot: Option<f64>,      // rad/s, + = turning right
    pub stw: Option<f64>,      // speed through water, m/s
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

    let position = nav.position.as_ref().and_then(|p| p.value.as_ref()).map(|v| Position {
        longitude: v.longitude,
        latitude: v.latitude,
        altitude: v.altitude,
    });

    VesselState {
        position,
        cog: nav.course_over_ground_true.as_ref().and_then(|v| v.value),
        sog: nav.speed_over_ground.as_ref().and_then(|v| v.value),
        heading: nav.heading_true.as_ref().and_then(|v| v.value),
    }
}

/// Compensates for the `signalk-aisstream` plugin ROT bug.
///
/// The plugin incorrectly converts the raw AIS ROT indicator I ∈ [-127, 127]
/// as if it were a plain angle in degrees (`I × π/180`), skipping the
/// ITU-R M.1371 square-root formula entirely.
///
/// This function:
/// 1. Inverts the plugin's wrong conversion to recover I ≈ received × 180/π
/// 2. Applies the correct formula:
///    - ROT_deg_min = sign(I) × (|I| / 4.733)²
///    - ROT_rad_s   = ROT_deg_min × π / 10800
///
/// Returns `None` for the "not available" sentinel (|I| > 127) or NaN/Inf.
///
/// TODO: remove once KEGustafsson/signalk-aisstream is fixed upstream.
fn compensate_aisstream_rot(received: f64) -> Option<f64> {
    if !received.is_finite() {
        return None;
    }
    // Recover the raw integer indicator that the plugin received.
    let abs_indicator = received.abs() * 180.0 / std::f64::consts::PI;
    // I = -128 (not available) would give abs_indicator ≈ 128; discard.
    if abs_indicator > 127.5 {
        return None;
    }
    // Apply correct ITU-R M.1371 formula.
    let rot_deg_per_min = (abs_indicator / 4.733_f64).powi(2);
    let rot_rad_per_sec = rot_deg_per_min * std::f64::consts::PI / 10800.0;
    // Sanity clamp: indicator=127 → 720°/min ≈ 0.209 rad/s; 0.5 is generous.
    if rot_rad_per_sec > 0.5 {
        return None;
    }
    Some(received.signum() * rot_rad_per_sec)
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
    let year: i32  = dp.next()?.parse().ok()?;
    let month: u32 = dp.next()?.parse().ok()?;
    let day: u32   = dp.next()?.parse().ok()?;
    let (hms, frac_str) = time.split_once('.').unwrap_or((time, ""));
    let mut tp = hms.split(':');
    let hour: i64 = tp.next()?.parse().ok()?;
    let min: i64  = tp.next()?.parse().ok()?;
    let sec: i64  = tp.next()?.parse().ok()?;
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
    let yoe = y - era * 400;                            // year of era [0, 399]
    let doy = (153 * (m - 3) + 2) / 5 + d - 1;         // day of year [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;   // day of era  [0, 146096]
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
pub fn extract_ais_targets(
    storage: &Storage,
    now_ms: f64,
    stale_ms: f64,
) -> Vec<AisTarget> {
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
            let heading = nav.heading_true.as_ref()
                .and_then(|v| v.value)
                .filter(|&h| (0.0..std::f64::consts::TAU).contains(&h));
            let cog = nav.course_over_ground_true.as_ref()
                .and_then(|v| v.value)
                .filter(|&c| (0.0..std::f64::consts::TAU).contains(&c));
            Some(AisTarget {
                id: id.clone(),
                mmsi: vessel.mmsi.clone(),
                name: vessel.name.clone(),
                position: Some(position),
                cog,
                sog: nav.speed_over_ground.as_ref().and_then(|v| v.value).filter(|v| v.is_finite()),
                heading,
                // The signalk-aisstream plugin incorrectly converts the raw AIS ROT
                // indicator I ∈ [-127,127] as a plain angle (× π/180) instead of
                // applying the correct ITU-R M.1371 sqrt formula. Compensate here
                // until the upstream plugin is fixed.
                rot: nav.rate_of_turn.as_ref().and_then(|v| v.value)
                    .and_then(compensate_aisstream_rot),
                stw: nav.speed_through_water.as_ref().and_then(|v| v.value).filter(|v| v.is_finite()),
                last_position_update_ms: last_ms,
            })
        })
        .collect()
}

/// Remove vessels from `storage` whose `navigation.datetime` is older than `stale_ms`
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
    let Some(vessels) = full.vessels.as_mut() else { return; };
    let before = vessels.len();
    vessels.retain(|_id, vessel| {
        let Some(nav) = vessel.navigation.as_ref() else { return true; };
        let Some(dt) = nav.datetime.as_ref() else { return true; };
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
        apply_message(&mut storage, r#"{
            "context": "vessels.urn:mrn:imo:mmsi:123456789",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 11.0, "latitude": 59.0}},
                {"path": "navigation.datetime", "value": "1970-01-01T00:04:00.000Z"}
            ]}]
        }"#).unwrap();

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
        apply_message(&mut storage, r#"{
            "context": "vessels.urn:mrn:imo:mmsi:999999999",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 11.0, "latitude": 59.0}},
                {"path": "navigation.datetime", "value": "1970-01-01T00:09:00.000Z"}
            ]}]
        }"#).unwrap();

        let now_ms = 20.0 * 60.0 * 1000.0;
        let targets = extract_ais_targets(&storage, now_ms, 10.0 * 60.0 * 1000.0);
        assert!(targets.is_empty(), "stale target should be dropped");
    }

    #[test]
    fn ais_target_without_datetime_dropped() {
        let mut storage = Storage::new(V1FullFormat::default());
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");

        apply_message(&mut storage, r#"{
            "context": "vessels.urn:mrn:imo:mmsi:111111111",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 11.0, "latitude": 59.0}}
            ]}]
        }"#).unwrap();

        let targets = extract_ais_targets(&storage, f64::INFINITY, 10.0 * 60.0 * 1000.0);
        assert!(targets.is_empty(), "vessel without datetime should be dropped");
    }

    #[test]
    fn prune_stale_vessels_removes_old_entries() {
        let mut storage = Storage::new(V1FullFormat::default());
        storage.set_self("vessels.urn:mrn:signalk:uuid:self");

        // Fresh vessel: datetime = 15 minutes after epoch
        apply_message(&mut storage, r#"{
            "context": "vessels.urn:mrn:imo:mmsi:111111111",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 10.0, "latitude": 59.0}},
                {"path": "navigation.datetime", "value": "1970-01-01T00:15:00.000Z"}
            ]}]
        }"#).unwrap();

        // Stale vessel: datetime = 1 minute after epoch
        apply_message(&mut storage, r#"{
            "context": "vessels.urn:mrn:imo:mmsi:999999999",
            "updates": [{"values": [
                {"path": "navigation.position", "value": {"longitude": 11.0, "latitude": 59.0}},
                {"path": "navigation.datetime", "value": "1970-01-01T00:01:00.000Z"}
            ]}]
        }"#).unwrap();

        // now = 20 minutes, stale = 10 minutes → vessel at 1min is stale, vessel at 15min is fresh
        let now_ms = 20.0 * 60.0 * 1000.0;
        let stale_ms = 10.0 * 60.0 * 1000.0;
        prune_stale_vessels(&mut storage, now_ms, stale_ms);

        let vessels = storage.data().vessels.as_ref().unwrap();
        assert!(vessels.contains_key("urn:mrn:imo:mmsi:111111111"), "fresh vessel should remain");
        assert!(!vessels.contains_key("urn:mrn:imo:mmsi:999999999"), "stale vessel should be pruned");
    }


    #[test]
    fn parse_iso8601_epoch() {
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:00:00.000Z"), Some(0.0));
    }

    #[test]
    fn parse_iso8601_known_timestamp() {
        // 2023-11-14T22:13:20.000Z = 1700000000000 ms (well-known Unix timestamp)
        assert_eq!(parse_iso8601_utc_ms("2023-11-14T22:13:20.000Z"), Some(1_700_000_000_000.0));
    }

    #[test]
    fn parse_iso8601_fractional_ms() {
        // 1 second + 500ms
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:00:01.5Z"), Some(1500.0));
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:00:01.123Z"), Some(1123.0));
        // microseconds truncated to ms
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:00:01.123456Z"), Some(1123.0));
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
    fn compensate_rot_typical_turn() {
        // Plugin sends indicator I=10 as 10 * π/180 ≈ 0.1745 rad/s (wrong).
        // Correct decode: (10/4.733)² = 4.467°/min → 0.001299 rad/s.
        let received = 10.0_f64 * std::f64::consts::PI / 180.0;
        let result = compensate_aisstream_rot(received).unwrap();
        let expected = (10.0_f64 / 4.733_f64).powi(2) * std::f64::consts::PI / 10800.0;
        assert!((result - expected).abs() < 1e-9, "result={result}, expected={expected}");
    }

    #[test]
    fn compensate_rot_sign_preserved() {
        let pos = compensate_aisstream_rot(5.0 * std::f64::consts::PI / 180.0).unwrap();
        let neg = compensate_aisstream_rot(-5.0 * std::f64::consts::PI / 180.0).unwrap();
        assert!(pos > 0.0);
        assert!(neg < 0.0);
    }

    #[test]
    fn compensate_rot_zero() {
        assert_eq!(compensate_aisstream_rot(0.0), Some(0.0));
    }

    #[test]
    fn compensate_rot_not_available_sentinel() {
        // |I| > 127.5 → not available
        let sentinel = 128.0_f64 * std::f64::consts::PI / 180.0;
        assert!(compensate_aisstream_rot(sentinel).is_none());
    }

    #[test]
    fn compensate_rot_nan_returns_none() {
        assert!(compensate_aisstream_rot(f64::NAN).is_none());
    }
}
