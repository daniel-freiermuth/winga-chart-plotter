//! Route resources — `/signalk/v2/api/resources/routes`. Ported from
//! `fetchAllRoutes`/`saveRoute`/`updateRoute`/`deleteRoute`/`buildRouteBody`
//! in `app/src/lib/signalk-api.ts`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineStringGeometry {
    #[serde(rename = "type")]
    pub kind: String, // always "LineString"
    pub coordinates: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteFeature {
    #[serde(rename = "type")]
    pub kind: String, // always "Feature"
    pub geometry: LineStringGeometry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub properties: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkRouteEntry {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature: Option<RouteFeature>,
}

pub type SkRouteRecord = HashMap<String, SkRouteEntry>;

/// A route/waypoint vertex as supplied by the route planner UI.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LonLat {
    pub lon: f64,
    pub lat: f64,
}

/// Earth radius in metres, expressed (as the original TS code does) via the
/// nautical-mile conversion factor: `1852 m/NM * 3440.065 NM == R_earth`.
const EARTH_RADIUS_M: f64 = 1852.0 * 3440.065;

/// Great-circle distance along a polyline, summed leg-by-leg (haversine).
fn route_distance_m(waypoints: &[LonLat]) -> f64 {
    let mut distance_m = 0.0;
    for i in 1..waypoints.len() {
        let a = waypoints[i - 1];
        let b = waypoints[i];
        let phi1 = a.lat.to_radians();
        let phi2 = b.lat.to_radians();
        let d_phi = (b.lat - a.lat).to_radians();
        let d_lambda = (b.lon - a.lon).to_radians();
        let h =
            (d_phi / 2.0).sin().powi(2) + phi1.cos() * phi2.cos() * (d_lambda / 2.0).sin().powi(2);
        distance_m += 2.0 * h.sqrt().atan2((1.0 - h).sqrt()) * EARTH_RADIUS_M;
    }
    distance_m
}

/// Build the POST/PUT body for `resources/routes`.
pub fn build_route_body(name: &str, waypoints: &[LonLat]) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "description": "",
        "distance": route_distance_m(waypoints).round(),
        "feature": {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": waypoints.iter().map(|w| [w.lon, w.lat]).collect::<Vec<_>>(),
            },
            "properties": {},
        },
    })
}

/// A POST `resources/routes`/`resources/waypoints` response: either a bare
/// UUID string, or an object carrying `id`/`uuid`.
pub fn extract_created_id(text: &str) -> String {
    let Ok(data) = serde_json::from_str::<serde_json::Value>(text) else {
        return String::new();
    };
    match data {
        serde_json::Value::String(s) => s,
        serde_json::Value::Object(o) => o
            .get("id")
            .or_else(|| o.get("uuid"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{build_route_body, extract_created_id, LonLat, SkRouteRecord};
    use crate::skrest::http;
    use wasm_bindgen::prelude::*;

    /// `GET /signalk/v2/api/resources/routes`
    #[wasm_bindgen(js_name = fetchAllRoutes)]
    pub async fn fetch_all_routes(server_base: String) -> Result<JsValue, JsValue> {
        let url = format!("{server_base}/signalk/v2/api/resources/routes");
        let resp = http::fetch("GET", &url, &JsValue::UNDEFINED, None, None).await?;
        if !resp.ok() {
            return Err(http::status_error("Routes API error", &resp));
        }
        let routes: SkRouteRecord = serde_json::from_str(&resp.text)
            .map_err(|e| JsValue::from_str(&format!("Routes API parse error: {e}")))?;
        crate::skrest::to_js_object(&routes)
    }

    /// `POST /signalk/v2/api/resources/routes` — returns the new route's UUID.
    #[wasm_bindgen(js_name = saveRoute)]
    pub async fn save_route(
        server_base: String,
        name: String,
        waypoints: JsValue,
        auth_headers: JsValue,
    ) -> Result<String, JsValue> {
        let waypoints: Vec<LonLat> = serde_wasm_bindgen::from_value(waypoints)?;
        let url = format!("{server_base}/signalk/v2/api/resources/routes");
        let body = build_route_body(&name, &waypoints).to_string();
        let resp = http::fetch("POST", &url, &auth_headers, Some(&body), None).await?;
        if !resp.ok() {
            return Err(http::status_error("Save route failed", &resp));
        }
        Ok(extract_created_id(&resp.text))
    }

    /// `PUT /signalk/v2/api/resources/routes/:uuid`
    #[wasm_bindgen(js_name = updateRoute)]
    pub async fn update_route(
        server_base: String,
        uuid: String,
        name: String,
        waypoints: JsValue,
        auth_headers: JsValue,
    ) -> Result<(), JsValue> {
        let waypoints: Vec<LonLat> = serde_wasm_bindgen::from_value(waypoints)?;
        let url = format!("{server_base}/signalk/v2/api/resources/routes/{uuid}");
        let body = build_route_body(&name, &waypoints).to_string();
        let resp = http::fetch("PUT", &url, &auth_headers, Some(&body), None).await?;
        if !resp.ok() {
            return Err(http::status_error("Update route failed", &resp));
        }
        Ok(())
    }

    /// `DELETE /signalk/v2/api/resources/routes/:uuid`
    #[wasm_bindgen(js_name = deleteRoute)]
    pub async fn delete_route(
        server_base: String,
        uuid: String,
        auth_headers: JsValue,
    ) -> Result<(), JsValue> {
        let url = format!("{server_base}/signalk/v2/api/resources/routes/{uuid}");
        let resp = http::fetch("DELETE", &url, &auth_headers, None, None).await?;
        if !resp.ok() {
            return Err(http::status_error("Delete route failed", &resp));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_zero_for_single_point() {
        assert_eq!(route_distance_m(&[LonLat { lon: 0.0, lat: 0.0 }]), 0.0);
    }

    #[test]
    fn distance_one_degree_latitude_is_60nm() {
        let d_m = route_distance_m(&[LonLat { lon: 0.0, lat: 0.0 }, LonLat { lon: 0.0, lat: 1.0 }]);
        let d_nm = d_m / 1852.0;
        assert!((d_nm - 60.0).abs() < 0.1, "expected ~60nm, got {d_nm}");
    }

    #[test]
    fn distance_sums_multiple_legs() {
        let one_leg =
            route_distance_m(&[LonLat { lon: 0.0, lat: 0.0 }, LonLat { lon: 0.0, lat: 1.0 }]);
        let two_legs = route_distance_m(&[
            LonLat { lon: 0.0, lat: 0.0 },
            LonLat { lon: 0.0, lat: 1.0 },
            LonLat { lon: 0.0, lat: 2.0 },
        ]);
        assert!((two_legs - 2.0 * one_leg).abs() < 1.0);
    }

    #[test]
    fn build_route_body_shape() {
        let body = build_route_body(
            "Helsinki to Tallinn",
            &[
                LonLat {
                    lon: 24.94,
                    lat: 60.17,
                },
                LonLat {
                    lon: 24.75,
                    lat: 59.44,
                },
            ],
        );
        assert_eq!(body["name"], "Helsinki to Tallinn");
        assert_eq!(body["description"], "");
        assert_eq!(body["feature"]["type"], "Feature");
        assert_eq!(body["feature"]["geometry"]["type"], "LineString");
        assert_eq!(
            body["feature"]["geometry"]["coordinates"],
            serde_json::json!([[24.94, 60.17], [24.75, 59.44]])
        );
        assert!(body["distance"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn extract_created_id_from_bare_string() {
        assert_eq!(extract_created_id("\"abc-123\""), "abc-123");
    }

    #[test]
    fn extract_created_id_from_id_field() {
        assert_eq!(extract_created_id(r#"{"id":"abc-123"}"#), "abc-123");
    }

    #[test]
    fn extract_created_id_from_uuid_field() {
        assert_eq!(extract_created_id(r#"{"uuid":"abc-123"}"#), "abc-123");
    }

    #[test]
    fn extract_created_id_prefers_id_over_uuid() {
        assert_eq!(extract_created_id(r#"{"id":"a","uuid":"b"}"#), "a");
    }

    #[test]
    fn extract_created_id_falls_back_to_empty() {
        assert_eq!(extract_created_id(r#"{}"#), "");
        assert_eq!(extract_created_id("not json"), "");
    }

    #[test]
    fn route_entry_round_trips_through_json() {
        let json = r#"{
            "name": "Test", "feature": { "type": "Feature",
            "geometry": { "type": "LineString", "coordinates": [[1.0, 2.0], [3.0, 4.0]] } }
        }"#;
        let entry: SkRouteEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.name, "Test");
        assert_eq!(
            entry.feature.unwrap().geometry.coordinates,
            vec![[1.0, 2.0], [3.0, 4.0]]
        );
    }
}
