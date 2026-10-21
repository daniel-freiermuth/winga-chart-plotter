//! Waypoint resources — `/signalk/v2/api/resources/waypoints`. Ported from
//! `fetchAllWaypoints`/`saveWaypoint`/`updateWaypoint`/`deleteWaypoint` in
//! `app/src/lib/signalk-api.ts`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointGeometry {
    #[serde(rename = "type")]
    pub kind: String, // always "Point"
    pub coordinates: [f64; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaypointFeature {
    #[serde(rename = "type")]
    pub kind: String, // always "Feature"
    pub geometry: PointGeometry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub properties: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkWaypointEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature: Option<WaypointFeature>,
}

pub type SkWaypointRecord = HashMap<String, SkWaypointEntry>;

/// Build the POST/PUT body for `resources/waypoints`.
pub fn build_waypoint_body(name: &str, lat: f64, lon: f64) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "feature": {
            "type": "Feature",
            "geometry": { "type": "Point", "coordinates": [lon, lat] },
            "properties": { "name": name },
        },
    })
}

/// Build the PUT body for `resources/waypoints/:uuid` from the server's
/// current copy. A Signal K PUT replaces the whole resource, so fields this
/// app does not edit (description, other `feature.properties`, vendor extras)
/// are carried over from `existing`; only name and position are replaced.
pub fn build_waypoint_update_body(
    existing: &serde_json::Value,
    name: &str,
    lat: f64,
    lon: f64,
) -> serde_json::Value {
    let fresh = build_waypoint_body(name, lat, lon);
    crate::skrest::routes::merge_update(
        existing,
        fresh,
        &["name"],
        &["type", "geometry"],
        &["name"],
    )
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{SkWaypointRecord, build_waypoint_body, build_waypoint_update_body};
    use crate::skrest::http;
    use crate::skrest::routes::extract_created_id;
    use wasm_bindgen::prelude::*;

    /// `GET /signalk/v2/api/resources/waypoints`
    #[wasm_bindgen(js_name = fetchAllWaypoints)]
    pub async fn fetch_all_waypoints(server_base: String) -> Result<JsValue, JsValue> {
        let url = format!("{server_base}/signalk/v2/api/resources/waypoints");
        let resp = http::fetch("GET", &url, &JsValue::UNDEFINED, None, None).await?;
        if !resp.ok() {
            return Err(http::status_error("Waypoints API error", &resp));
        }
        let waypoints: SkWaypointRecord = serde_json::from_str(&resp.text)
            .map_err(|e| JsValue::from_str(&format!("Waypoints API parse error: {e}")))?;
        crate::skrest::to_js_object(&waypoints)
    }

    /// `POST /signalk/v2/api/resources/waypoints` — returns the new waypoint's UUID.
    #[wasm_bindgen(js_name = saveWaypoint)]
    pub async fn save_waypoint(
        server_base: String,
        name: String,
        lat: f64,
        lon: f64,
        auth_headers: JsValue,
    ) -> Result<String, JsValue> {
        let url = format!("{server_base}/signalk/v2/api/resources/waypoints");
        let body = build_waypoint_body(&name, lat, lon).to_string();
        let resp = http::fetch("POST", &url, &auth_headers, Some(&body), None).await?;
        if !resp.ok() {
            return Err(http::status_error("Save waypoint failed", &resp));
        }
        Ok(extract_created_id(&resp.text))
    }

    /// `PUT /signalk/v2/api/resources/waypoints/:uuid` — renames a waypoint
    /// (position unchanged in practice, but the body still carries it).
    #[wasm_bindgen(js_name = updateWaypoint)]
    pub async fn update_waypoint(
        server_base: String,
        uuid: String,
        name: String,
        lat: f64,
        lon: f64,
        auth_headers: JsValue,
    ) -> Result<(), JsValue> {
        let url = format!("{server_base}/signalk/v2/api/resources/waypoints/{uuid}");
        // PUT replaces the whole resource: start from the server's copy so
        // fields this app does not edit survive.
        let current = http::fetch("GET", &url, &auth_headers, None, None).await?;
        if !current.ok() {
            return Err(http::status_error("Update waypoint failed", &current));
        }
        let existing: serde_json::Value = serde_json::from_str(&current.text)
            .map_err(|e| JsValue::from_str(&format!("Update waypoint parse error: {e}")))?;
        let body = build_waypoint_update_body(&existing, &name, lat, lon).to_string();
        let resp = http::fetch("PUT", &url, &auth_headers, Some(&body), None).await?;
        if !resp.ok() {
            return Err(http::status_error("Update waypoint failed", &resp));
        }
        Ok(())
    }

    /// `DELETE /signalk/v2/api/resources/waypoints/:uuid`
    #[wasm_bindgen(js_name = deleteWaypoint)]
    pub async fn delete_waypoint(
        server_base: String,
        uuid: String,
        auth_headers: JsValue,
    ) -> Result<(), JsValue> {
        let url = format!("{server_base}/signalk/v2/api/resources/waypoints/{uuid}");
        let resp = http::fetch("DELETE", &url, &auth_headers, None, None).await?;
        if !resp.ok() {
            return Err(http::status_error("Delete waypoint failed", &resp));
        }
        Ok(())
    }
}

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

    #[test]
    fn build_waypoint_body_shape() {
        let body = build_waypoint_body("My mark", 60.17, 24.94);
        assert_eq!(body["name"], "My mark");
        assert_eq!(body["feature"]["type"], "Feature");
        assert_eq!(body["feature"]["geometry"]["type"], "Point");
        assert_eq!(
            body["feature"]["geometry"]["coordinates"],
            serde_json::json!([24.94, 60.17])
        );
        assert_eq!(body["feature"]["properties"]["name"], "My mark");
    }

    #[test]
    fn waypoint_update_preserves_unedited_fields() {
        let existing = serde_json::json!({
            "name": "Old",
            "description": "Fuel dock",
            "type": "harbour",
            "feature": {
                "type": "Feature",
                "geometry": { "type": "Point", "coordinates": [1.0, 2.0] },
                "properties": { "name": "Old", "skIcon": "fuel" },
            },
        });
        let body = build_waypoint_update_body(&existing, "New", 60.17, 24.94);
        assert_eq!(body["name"], "New");
        assert_eq!(body["description"], "Fuel dock");
        assert_eq!(body["type"], "harbour");
        assert_eq!(body["feature"]["properties"]["name"], "New");
        assert_eq!(body["feature"]["properties"]["skIcon"], "fuel");
        assert_eq!(
            body["feature"]["geometry"]["coordinates"],
            serde_json::json!([24.94, 60.17])
        );
    }

    #[test]
    fn waypoint_update_without_usable_original_is_fresh_body() {
        let body = build_waypoint_update_body(&serde_json::json!("x"), "N", 1.0, 2.0);
        assert_eq!(body, build_waypoint_body("N", 1.0, 2.0));
    }

    #[test]
    fn waypoint_entry_round_trips_with_optional_name() {
        let json = r#"{
            "feature": { "type": "Feature",
            "geometry": { "type": "Point", "coordinates": [24.94, 60.17] } }
        }"#;
        let entry: SkWaypointEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.name, None);
        assert_eq!(entry.feature.unwrap().geometry.coordinates, [24.94, 60.17]);
    }
}
