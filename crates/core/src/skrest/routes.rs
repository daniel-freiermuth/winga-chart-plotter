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
    for leg in waypoints.windows(2) {
        let [a, b] = *leg else { continue };
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
///
/// Returns `Err` when `waypoints` has fewer than 2 entries, because a
/// GeoJSON `LineString` requires at least two positions (RFC 7946 §3.1.4).
pub fn build_route_body(name: &str, waypoints: &[LonLat]) -> crate::Result<serde_json::Value> {
    if waypoints.len() < 2 {
        return Err(crate::Error::TooFewWaypoints(waypoints.len()));
    }
    Ok(serde_json::json!({
        "name": name,
        "description": "",
        "distance": route_distance_m(waypoints).round(),
        "feature": {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": waypoints
                    .iter()
                    .map(|w| [crate::geo::canonical_lon(w.lon), w.lat])
                    .collect::<Vec<_>>(),
            },
            "properties": {},
        },
    }))
}

/// Build the PUT body for `resources/routes/:uuid` from the server's current
/// copy of the route. A Signal K PUT replaces the whole resource, so fields
/// the planner does not edit (description, `feature.properties`, vendor
/// extras) are carried over from `existing`; only the name, distance and
/// geometry are taken from the edit. The index-aligned
/// `feature.properties.coordinatesMeta` is realigned to the new geometry, or
/// dropped when that is not possible (see [`realign_coordinates_meta`]).
///
/// Returns `Err` under the same conditions as [`build_route_body`].
pub fn build_route_update_body(
    existing: &serde_json::Value,
    name: &str,
    waypoints: &[LonLat],
) -> crate::Result<serde_json::Value> {
    let fresh = build_route_body(name, waypoints)?;
    let mut body = merge_update(
        existing,
        fresh,
        &["name", "distance"],
        &["type", "geometry"],
        &[],
    );
    if let Some(props) = body
        .pointer_mut("/feature/properties")
        .and_then(serde_json::Value::as_object_mut)
        && props.contains_key("coordinatesMeta")
    {
        match realign_coordinates_meta(existing, waypoints) {
            Some(meta) => {
                props.insert(
                    "coordinatesMeta".to_string(),
                    serde_json::Value::Array(meta),
                );
            }
            None => {
                props.remove("coordinatesMeta");
            }
        }
    }
    Ok(body)
}

/// Map the existing route's `coordinatesMeta` (entry `i` describes coordinate
/// `i`) onto the edited geometry. Each new vertex is matched, in order, to an
/// unchanged existing vertex. Returns:
/// - the matched entries when every new vertex matched (points removed);
/// - the entries unchanged when the length is the same and every match sits
///   at its original index (points moved in place);
/// - `None` otherwise (points inserted or reordered), or when the existing
///   meta is not a coordinate-aligned array — stale metadata would attach
///   names / waypoint hrefs to the wrong vertices.
fn realign_coordinates_meta(
    existing: &serde_json::Value,
    waypoints: &[LonLat],
) -> Option<Vec<serde_json::Value>> {
    let meta = existing
        .pointer("/feature/properties/coordinatesMeta")?
        .as_array()?;
    let old: Vec<[f64; 2]> =
        serde_json::from_value(existing.pointer("/feature/geometry/coordinates")?.clone()).ok()?;
    if meta.len() != old.len() {
        return None;
    }
    let mut realigned = Vec::with_capacity(waypoints.len());
    let mut in_place = old.len() == waypoints.len();
    let mut any_moved = false;
    let mut cursor = 0;
    for (i, w) in waypoints.iter().enumerate() {
        let found = old.get(cursor..)?.iter().position(|&[lon, lat]| {
            // Exact identity: unedited vertices round-trip bit-for-bit.
            lon.to_bits() == w.lon.to_bits() && lat.to_bits() == w.lat.to_bits()
        });
        match found {
            Some(offset) => {
                let j = cursor + offset;
                in_place &= i == j;
                realigned.push(meta.get(j)?.clone());
                cursor = j + 1;
            }
            None if in_place => {
                any_moved = true;
                realigned.push(meta.get(i)?.clone());
            }
            None => return None,
        }
    }
    // A moved vertex only keeps its entry if nothing around it shifted.
    (in_place || !any_moved).then_some(realigned)
}

/// Overlay the edited parts of `fresh` onto `existing`: top-level `top_keys`,
/// `feature.*` `feature_keys` and `feature.properties.*` `prop_keys` come from
/// `fresh`; everything else in `existing` is kept. Returns `fresh` unchanged
/// when `existing` is not a JSON object.
pub(crate) fn merge_update(
    existing: &serde_json::Value,
    fresh: serde_json::Value,
    top_keys: &[&str],
    feature_keys: &[&str],
    prop_keys: &[&str],
) -> serde_json::Value {
    let Some(mut out) = existing.as_object().cloned() else {
        return fresh;
    };
    let serde_json::Value::Object(mut fresh) = fresh else {
        return fresh;
    };
    for key in top_keys {
        if let Some(v) = fresh.remove(*key) {
            out.insert((*key).to_string(), v);
        }
    }
    let mut fresh_feature = match fresh.remove("feature") {
        Some(serde_json::Value::Object(f)) => f,
        _ => serde_json::Map::new(),
    };
    let mut feature = match out.remove("feature") {
        Some(serde_json::Value::Object(f)) => f,
        _ => serde_json::Map::new(),
    };
    for key in feature_keys {
        if let Some(v) = fresh_feature.remove(*key) {
            feature.insert((*key).to_string(), v);
        }
    }
    if !prop_keys.is_empty() {
        let mut fresh_props = match fresh_feature.remove("properties") {
            Some(serde_json::Value::Object(p)) => p,
            _ => serde_json::Map::new(),
        };
        let mut props = match feature.remove("properties") {
            Some(serde_json::Value::Object(p)) => p,
            _ => serde_json::Map::new(),
        };
        for key in prop_keys {
            if let Some(v) = fresh_props.remove(*key) {
                props.insert((*key).to_string(), v);
            }
        }
        feature.insert("properties".to_string(), serde_json::Value::Object(props));
    } else if !feature.contains_key("properties")
        && let Some(p) = fresh_feature.remove("properties")
    {
        feature.insert("properties".to_string(), p);
    }
    out.insert("feature".to_string(), serde_json::Value::Object(feature));
    serde_json::Value::Object(out)
}

/// A POST `resources/routes`/`resources/waypoints` response: either a bare
/// UUID string, or an object carrying `id`/`uuid`. Returns `None` when the
/// body is unparsable, carries no string id, or the id is empty — an empty id
/// would turn `/resources/<kind>/{id}` into the collection URL.
pub fn extract_created_id(text: &str) -> Option<String> {
    let data = serde_json::from_str::<serde_json::Value>(text).ok()?;
    let id = match data {
        serde_json::Value::String(s) => s,
        serde_json::Value::Object(o) => o
            .get("id")
            .or_else(|| o.get("uuid"))
            .and_then(|v| v.as_str())?
            .to_string(),
        _ => return None,
    };
    (!id.is_empty()).then_some(id)
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{
        LonLat, SkRouteRecord, build_route_body, build_route_update_body, extract_created_id,
    };
    use crate::skrest::http;
    use wasm_bindgen::prelude::*;

    /// `GET /signalk/v2/api/resources/routes`
    #[wasm_bindgen(js_name = fetchAllRoutes)]
    pub async fn fetch_all_routes(server_base: String) -> Result<JsValue, JsValue> {
        let url = format!("{server_base}/signalk/v2/api/resources/routes");
        let resp =
            http::fetch_ok("GET", &url, &JsValue::UNDEFINED, None, "Routes API error").await?;
        let routes: SkRouteRecord =
            serde_json::from_str(&resp.text).map_err(crate::Error::json("Routes API"))?;
        crate::skrest::to_js_object(&routes)
    }

    /// `POST /signalk/v2/api/resources/routes` — returns the new route's UUID,
    /// or `undefined` if the server's 2xx response did not carry one.
    #[wasm_bindgen(js_name = saveRoute)]
    pub async fn save_route(
        server_base: String,
        name: String,
        waypoints: JsValue,
        auth_headers: JsValue,
    ) -> Result<Option<String>, JsValue> {
        let waypoints: Vec<LonLat> = serde_wasm_bindgen::from_value(waypoints)?;
        let url = format!("{server_base}/signalk/v2/api/resources/routes");
        let body = build_route_body(&name, &waypoints)?.to_string();
        let resp = http::fetch_ok(
            "POST",
            &url,
            &auth_headers,
            Some(&body),
            "Save route failed",
        )
        .await?;
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
        // PUT replaces the whole resource: start from the server's copy so
        // fields the planner does not edit survive.
        let current =
            http::fetch_ok("GET", &url, &auth_headers, None, "Update route failed").await?;
        let existing: serde_json::Value =
            serde_json::from_str(&current.text).map_err(crate::Error::json("Update route"))?;
        let body = build_route_update_body(&existing, &name, &waypoints)?.to_string();
        http::fetch_ok(
            "PUT",
            &url,
            &auth_headers,
            Some(&body),
            "Update route failed",
        )
        .await?;
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
        http::fetch_ok("DELETE", &url, &auth_headers, None, "Delete route failed").await?;
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
        )
        .unwrap();
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
    fn build_route_body_wraps_unwrapped_longitudes() {
        // Map events right of the antimeridian unproject to lon > 180.
        let body = build_route_body(
            "Across the dateline",
            &[
                LonLat {
                    lon: 179.5,
                    lat: -17.0,
                },
                LonLat {
                    lon: 180.5,
                    lat: -17.0,
                },
                LonLat {
                    lon: -181.0,
                    lat: -17.5,
                },
            ],
        )
        .unwrap();
        assert_eq!(
            body["feature"]["geometry"]["coordinates"],
            serde_json::json!([[179.5, -17.0], [-179.5, -17.0], [179.0, -17.5]])
        );
    }

    #[test]
    fn route_update_preserves_unedited_fields() {
        let existing = serde_json::json!({
            "name": "Old",
            "description": "Harbour approach",
            "distance": 1.0,
            "x-vendor": 7,
            "feature": {
                "type": "Feature",
                "geometry": { "type": "LineString", "coordinates": [[0.0, 0.0], [1.0, 1.0]] },
                "properties": { "coordinatesMeta": [{ "name": "A" }, { "name": "B" }] },
                "id": "f1",
            },
        });
        let body = build_route_update_body(
            &existing,
            "New",
            &[LonLat { lon: 0.0, lat: 0.0 }, LonLat { lon: 0.0, lat: 1.0 }],
        )
        .unwrap();
        assert_eq!(body["name"], "New");
        assert_eq!(body["description"], "Harbour approach");
        assert_eq!(body["x-vendor"], 7);
        assert_eq!(body["feature"]["id"], "f1");
        assert_eq!(
            body["feature"]["properties"]["coordinatesMeta"][1]["name"],
            "B"
        );
        assert_eq!(
            body["feature"]["geometry"]["coordinates"],
            serde_json::json!([[0.0, 0.0], [0.0, 1.0]])
        );
        assert!(body["distance"].as_f64().unwrap() > 100_000.0);
    }

    #[test]
    fn route_update_without_usable_original_is_fresh_body() {
        let pts = [LonLat { lon: 0.0, lat: 0.0 }, LonLat { lon: 0.0, lat: 1.0 }];
        let body = build_route_update_body(&serde_json::Value::Null, "R", &pts).unwrap();
        assert_eq!(body, build_route_body("R", &pts).unwrap());
    }

    fn route_with_meta(coords: &serde_json::Value, meta: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "name": "R",
            "feature": {
                "type": "Feature",
                "geometry": { "type": "LineString", "coordinates": coords },
                "properties": { "coordinatesMeta": meta, "keep": 1 },
            },
        })
    }

    fn lonlat(pts: &[[f64; 2]]) -> Vec<LonLat> {
        pts.iter().map(|&[lon, lat]| LonLat { lon, lat }).collect()
    }

    #[test]
    fn route_update_realigns_coordinates_meta_after_removal() {
        let existing = route_with_meta(
            &serde_json::json!([[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]),
            &serde_json::json!([
                { "href": "/resources/waypoints/wp1" },
                { "href": "/resources/waypoints/wp2" },
                { "href": "/resources/waypoints/wp3" },
            ]),
        );
        let body =
            build_route_update_body(&existing, "R", &lonlat(&[[0.0, 0.0], [2.0, 2.0]])).unwrap();
        assert_eq!(
            body["feature"]["properties"]["coordinatesMeta"],
            serde_json::json!([
                { "href": "/resources/waypoints/wp1" },
                { "href": "/resources/waypoints/wp3" },
            ])
        );
        assert_eq!(body["feature"]["properties"]["keep"], 1);
    }

    #[test]
    fn route_update_drops_coordinates_meta_after_insertion() {
        let existing = route_with_meta(
            &serde_json::json!([[0.0, 0.0], [2.0, 2.0]]),
            &serde_json::json!([{ "name": "A" }, { "name": "C" }]),
        );
        let body = build_route_update_body(
            &existing,
            "R",
            &lonlat(&[[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]),
        )
        .unwrap();
        let props = &body["feature"]["properties"];
        assert!(props.get("coordinatesMeta").is_none(), "got {props}");
        assert_eq!(props["keep"], 1);
    }

    #[test]
    fn route_update_drops_coordinates_meta_after_same_length_reshuffle() {
        let existing = route_with_meta(
            &serde_json::json!([[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]),
            &serde_json::json!([{ "name": "A" }, { "name": "B" }, { "name": "C" }]),
        );
        // Same length, but positions no longer line up: remove B and append
        // D; insert X before B and drop C.
        for edited in [
            [[0.0, 0.0], [2.0, 2.0], [3.0, 3.0]],
            [[0.0, 0.0], [9.0, 9.0], [1.0, 1.0]],
        ] {
            let body = build_route_update_body(&existing, "R", &lonlat(&edited)).unwrap();
            let props = &body["feature"]["properties"];
            assert!(
                props.get("coordinatesMeta").is_none(),
                "{edited:?}: got {props}"
            );
        }
    }

    #[test]
    fn build_route_body_rejects_empty_waypoints() {
        let result = build_route_body("empty", &[]);
        assert!(
            matches!(result, Err(crate::Error::TooFewWaypoints(0))),
            "0 waypoints must be rejected, got {result:?}"
        );
    }

    #[test]
    fn build_route_body_rejects_single_waypoint() {
        let result = build_route_body(
            "solo",
            &[LonLat {
                lon: 24.94,
                lat: 60.17,
            }],
        );
        assert!(
            matches!(result, Err(crate::Error::TooFewWaypoints(1))),
            "1 waypoint must be rejected, got {result:?}"
        );
    }

    #[test]
    fn extract_created_id_from_bare_string() {
        assert_eq!(
            extract_created_id("\"abc-123\"").as_deref(),
            Some("abc-123")
        );
    }

    #[test]
    fn extract_created_id_from_id_field() {
        assert_eq!(
            extract_created_id(r#"{"id":"abc-123"}"#).as_deref(),
            Some("abc-123")
        );
    }

    #[test]
    fn extract_created_id_from_uuid_field() {
        assert_eq!(
            extract_created_id(r#"{"uuid":"abc-123"}"#).as_deref(),
            Some("abc-123")
        );
    }

    #[test]
    fn extract_created_id_prefers_id_over_uuid() {
        assert_eq!(
            extract_created_id(r#"{"id":"a","uuid":"b"}"#).as_deref(),
            Some("a")
        );
    }

    #[test]
    fn extract_created_id_none_when_id_absent_or_invalid() {
        assert_eq!(extract_created_id("not json"), None);
        assert_eq!(extract_created_id("{}"), None);
        assert_eq!(extract_created_id("42"), None);
        assert_eq!(extract_created_id(r#"{"id":42}"#), None);
    }

    #[test]
    fn extract_created_id_none_when_id_empty() {
        assert_eq!(extract_created_id("\"\""), None);
        assert_eq!(extract_created_id(r#"{"id":""}"#), None);
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
