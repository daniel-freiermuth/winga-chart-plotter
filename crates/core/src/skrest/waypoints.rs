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

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{SkWaypointRecord, build_waypoint_body};
    use crate::skrest::http;
    use crate::skrest::routes::extract_created_id;
    use wasm_bindgen::prelude::*;

    /// `GET /signalk/v2/api/resources/waypoints`
    #[wasm_bindgen(js_name = fetchAllWaypoints)]
    pub async fn fetch_all_waypoints(server_base: String) -> Result<JsValue, JsValue> {
        let url = format!("{server_base}/signalk/v2/api/resources/waypoints");
        let resp = http::fetch_ok(
            "GET",
            &url,
            &JsValue::UNDEFINED,
            None,
            "Waypoints API error",
        )
        .await?;
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
        let resp = http::fetch_ok(
            "POST",
            &url,
            &auth_headers,
            Some(&body),
            "Save waypoint failed",
        )
        .await?;
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
        let body = build_waypoint_body(&name, lat, lon).to_string();
        http::fetch_ok(
            "PUT",
            &url,
            &auth_headers,
            Some(&body),
            "Update waypoint failed",
        )
        .await?;
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
        http::fetch_ok(
            "DELETE",
            &url,
            &auth_headers,
            None,
            "Delete waypoint failed",
        )
        .await?;
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
