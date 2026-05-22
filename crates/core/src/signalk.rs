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
    pub heading: Option<f64>, // Magnetic heading, radians
}

#[wasm_bindgen]
impl VesselState {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
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
        heading: nav.heading_magnetic.as_ref().and_then(|v| v.value),
    }
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
}
