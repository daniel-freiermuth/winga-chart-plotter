use serde::{Deserialize, Serialize};
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

/// Core Signal K delta parsing logic, usable on all targets including native tests.
pub fn apply_signalk_delta(state: &VesselState, delta_json: &str) -> Result<VesselState, String> {
    let delta: serde_json::Value = serde_json::from_str(delta_json)
        .map_err(|e| format!("JSON parse error: {e}"))?;

    let mut new_state = state.clone();

    if let Some(updates) = delta.get("updates").and_then(|u| u.as_array()) {
        for update in updates {
            if let Some(values) = update.get("values").and_then(|v| v.as_array()) {
                for value in values {
                    let path = value.get("path").and_then(|p| p.as_str()).unwrap_or("");
                    let v = &value["value"];
                    match path {
                        "navigation.position" => {
                            if let (Some(lon), Some(lat)) = (
                                v.get("longitude").and_then(|x| x.as_f64()),
                                v.get("latitude").and_then(|x| x.as_f64()),
                            ) {
                                new_state.position = Some(Position::new(lon, lat));
                            }
                        }
                        "navigation.courseOverGroundTrue" => {
                            new_state.cog = v.as_f64();
                        }
                        "navigation.speedOverGround" => {
                            new_state.sog = v.as_f64();
                        }
                        "navigation.headingMagnetic" => {
                            new_state.heading = v.as_f64();
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(new_state)
}

/// Parse a Signal K delta JSON string and update a VesselState.
/// WASM entry point — wraps `apply_signalk_delta` with a JS-compatible error type.
#[wasm_bindgen]
pub fn parse_signalk_delta(state: &VesselState, delta_json: &str) -> Result<VesselState, JsValue> {
    apply_signalk_delta(state, delta_json).map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_position_delta() {
        let state = VesselState::new();
        let delta = r#"{
            "updates": [{
                "values": [{
                    "path": "navigation.position",
                    "value": { "longitude": 10.75, "latitude": 59.91 }
                }]
            }]
        }"#;
        let updated = apply_signalk_delta(&state, delta).unwrap();
        let pos = updated.position.unwrap();
        assert!((pos.longitude - 10.75).abs() < 1e-9);
        assert!((pos.latitude - 59.91).abs() < 1e-9);
    }

    #[test]
    fn ignore_unknown_paths() {
        let state = VesselState::new();
        let delta = r#"{"updates": [{"values": [{"path": "unknown.path", "value": 42}]}]}"#;
        let updated = apply_signalk_delta(&state, delta).unwrap();
        assert!(updated.position.is_none());
    }

    #[test]
    fn malformed_json_returns_error() {
        let state = VesselState::new();
        let result = apply_signalk_delta(&state, "not json");
        assert!(result.is_err());
    }
}
