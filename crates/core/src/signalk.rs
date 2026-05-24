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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

/// Extract all non-self AIS targets that have a known position.
pub fn extract_ais_targets(storage: &Storage) -> Vec<AisTarget> {
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
            })
        })
        .collect()
}

/// Apply a Signal K stream message (hello / full / delta) to a `Storage`.
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
                    storage.set_self(ctx);
                }
            }
            storage.update(&delta);
        }
        SignalKStreamMessage::Hello(hello) => {
            if let Some(self_urn) = hello.self_ {
                storage.set_self(&self_urn);
            }
        }
        SignalKStreamMessage::BadData => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use signalk::V1FullFormat;

    fn make_storage_with_delta(delta_json: &str) -> Storage {
        let mut storage = Storage::new(V1FullFormat::default());
        apply_message(&mut storage, delta_json).unwrap();
        storage
    }

    #[test]
    fn parse_position_delta() {
        let delta = r#"{
            "context": "vessels.urn:mrn:signalk:uuid:test",
            "updates": [{
                "values": [{
                    "path": "navigation.position",
                    "value": { "longitude": 10.75, "latitude": 59.91 }
                }]
            }]
        }"#;
        // Storage with a known self_ id matching the context
        let mut storage = Storage::new(V1FullFormat::default());
        storage.set_self("vessels.urn:mrn:signalk:uuid:test");
        apply_message(&mut storage, delta).unwrap();
        let state = extract_vessel_state(&storage);
        let pos = state.position.unwrap();
        assert!((pos.longitude - 10.75).abs() < 1e-9);
        assert!((pos.latitude - 59.91).abs() < 1e-9);
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

        // Self vessel delta
        apply_message(&mut storage, r#"{
            "context": "vessels.urn:mrn:signalk:uuid:self",
            "updates": [{"values": [{"path": "navigation.position", "value": {"longitude": 10.0, "latitude": 58.0}}]}]
        }"#).unwrap();

        // AIS target delta
        apply_message(&mut storage, r#"{
            "context": "vessels.urn:mrn:imo:mmsi:123456789",
            "updates": [{"values": [{"path": "navigation.position", "value": {"longitude": 11.0, "latitude": 59.0}}]}]
        }"#).unwrap();

        let targets = extract_ais_targets(&storage);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].id, "urn:mrn:imo:mmsi:123456789");
        let pos = targets[0].position.unwrap();
        assert!((pos.longitude - 11.0).abs() < 1e-9);
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
        assert!((pos + neg).abs() < 1e-15);
    }

    #[test]
    fn compensate_rot_zero() {
        let result = compensate_aisstream_rot(0.0).unwrap();
        assert_eq!(result, 0.0);
    }

    #[test]
    fn compensate_rot_not_available_sentinel() {
        // I = -128 (not available): received ≈ -128 * π/180 ≈ -2.234 rad/s
        let received = -128.0_f64 * std::f64::consts::PI / 180.0;
        assert!(compensate_aisstream_rot(received).is_none());
    }

    #[test]
    fn compensate_rot_max_indicator() {
        // I = 127: received ≈ 2.217 rad/s; correct output ≈ 0.209 rad/s
        let received = 127.0_f64 * std::f64::consts::PI / 180.0;
        let result = compensate_aisstream_rot(received).unwrap();
        assert!((result - 0.2094).abs() < 0.001, "result={result}");
        assert!(result <= 0.5);
    }

    #[test]
    fn compensate_rot_nan_returns_none() {
        assert!(compensate_aisstream_rot(f64::NAN).is_none());
        assert!(compensate_aisstream_rot(f64::INFINITY).is_none());
    }
}
