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
            let position = Position {
                longitude: pos_value.longitude,
                latitude: pos_value.latitude,
                altitude: pos_value.altitude,
            };
            Some(AisTarget {
                id: id.clone(),
                mmsi: vessel.mmsi.clone(),
                name: vessel.name.clone(),
                position: Some(position),
                cog: nav.course_over_ground_true.as_ref().and_then(|v| v.value),
                sog: nav.speed_over_ground.as_ref().and_then(|v| v.value),
                heading: nav.heading_true.as_ref().and_then(|v| v.value),
                rot: nav.rate_of_turn.as_ref().and_then(|v| v.value),
                stw: nav.speed_through_water.as_ref().and_then(|v| v.value),
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
}
