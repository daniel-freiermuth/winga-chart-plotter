//! Track/position history — `/signalk/v2/api/history/values`,
//! `/signalk/v1/api/self/track`, `/signalk/v1/api/tracks`, and
//! `/signalk/v1/api/vessels/:id/track`. Ported from `fetchTrack`/
//! `fetchAisVesselTrack`/`extractTrackCoords`/`dedupCoords` in
//! `app/src/lib/signalk-api.ts`.
//!
//! `fetchTrack`'s deliberate v2-history/v1-buffer/`@signalk/tracks` 3-way
//! fallback is ported verbatim, not "fixed" — see ADR-009 non-goals.

use super::urlenc::{encode_uri_component, form_urlencoded};
use serde_json::Value as Json;

// ---------------------------------------------------------------------------
// Pure: epoch-ms -> ISO 8601 UTC string (the inverse of skdata's
// `parse_iso8601_utc_ms`/`days_from_epoch` — same Hinnant civil-calendar
// algorithm, independently implemented here since skdata's is private and
// this module has no other reason to depend on `skdata`).
// ---------------------------------------------------------------------------

/// Inverse of "days from civil" (Howard Hinnant's public-domain algorithm):
/// days-since-epoch -> (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Format epoch milliseconds as a UTC ISO 8601 string, matching
/// `Date.prototype.toISOString()` for ordinary (4-digit-year) dates.
pub fn ms_to_iso8601(ms: f64) -> String {
    let total_ms = ms.round() as i64;
    let days = total_ms.div_euclid(86_400_000);
    let ms_of_day = total_ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let hh = ms_of_day / 3_600_000;
    let mm = (ms_of_day / 60_000) % 60;
    let ss = (ms_of_day / 1000) % 60;
    let millis = ms_of_day % 1000;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

// ---------------------------------------------------------------------------
// Pure: GeoJSON coordinate extraction + dedup (identical to the TS originals).
// ---------------------------------------------------------------------------

fn filter_coord_pairs(arr: &[Json]) -> Vec<[f64; 2]> {
    arr.iter()
        .filter_map(|c| {
            let a = c.as_array()?;
            if a.len() < 2 {
                return None;
            }
            Some([a[0].as_f64()?, a[1].as_f64()?])
        })
        .collect()
}

/// Extract `[lon, lat]` pairs from a GeoJSON `Feature`/`FeatureCollection`/
/// `LineString`/`MultiLineString` of unknown shape; any other shape (or a
/// malformed one) yields an empty vec, never an error.
pub fn extract_track_coords(geojson: &Json) -> Vec<[f64; 2]> {
    match geojson.get("type").and_then(Json::as_str) {
        Some("FeatureCollection") => geojson
            .get("features")
            .and_then(Json::as_array)
            .map(|features| features.iter().flat_map(extract_track_coords).collect())
            .unwrap_or_default(),
        Some("Feature") => geojson
            .get("geometry")
            .map(extract_track_coords)
            .unwrap_or_default(),
        Some("LineString") => geojson
            .get("coordinates")
            .and_then(Json::as_array)
            .map(|arr| filter_coord_pairs(arr))
            .unwrap_or_default(),
        Some("MultiLineString") => geojson
            .get("coordinates")
            .and_then(Json::as_array)
            .map(|lines| {
                lines
                    .iter()
                    .flat_map(|line| {
                        line.as_array()
                            .map(|a| filter_coord_pairs(a))
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// ~5 metres in degrees² — fast planar dedup approximation (matches the TS constant).
const TRACK_DEDUP_SQ_DEG: f64 = (5.0 / 111_320.0) * (5.0 / 111_320.0);

/// Deduplicate a coordinate array by dropping points within ~5 m of the
/// previous *kept* point. Used when merging track sources that may overlap.
pub fn dedup_coords(coords: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut out: Vec<[f64; 2]> = Vec::new();
    let mut prev: Option<[f64; 2]> = None;
    for &[lon, lat] in coords {
        let keep = match prev {
            None => true,
            Some([plon, plat]) => {
                let d_lon = lon - plon;
                let d_lat = lat - plat;
                d_lon * d_lon + d_lat * d_lat >= TRACK_DEDUP_SQ_DEG
            }
        };
        if keep {
            out.push([lon, lat]);
            prev = Some([lon, lat]);
        }
    }
    out
}

/// Parse the v2 History API's `{ data?: [string, {longitude?,latitude?}|null][] }` shape.
pub fn extract_history_coords(body_text: &str) -> Vec<[f64; 2]> {
    let Ok(v) = serde_json::from_str::<Json>(body_text) else {
        return Vec::new();
    };
    let Some(data) = v.get("data").and_then(Json::as_array) else {
        return Vec::new();
    };
    data.iter()
        .filter_map(|entry| {
            let pair = entry.as_array()?;
            let pos = pair.get(1)?;
            if pos.is_null() {
                return None;
            }
            let lon = pos.get("longitude").and_then(Json::as_f64)?;
            let lat = pos.get("latitude").and_then(Json::as_f64)?;
            Some([lon, lat])
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Pure: URL building (one fn per endpoint, preserving each call site's exact
// param order — `URLSearchParams` serialises in object-literal insertion order).
// ---------------------------------------------------------------------------

pub fn v2_history_url_own_vessel(server_base: &str, from_iso: &str) -> String {
    let qs = form_urlencoded(&[("paths", "navigation.position"), ("from", from_iso)]);
    format!("{server_base}/signalk/v2/api/history/values?{qs}")
}

pub fn v2_history_url_for_vessel(server_base: &str, vessel_id: &str, from_iso: &str) -> String {
    let context = format!("vessels.{vessel_id}");
    let qs = form_urlencoded(&[
        ("context", &context),
        ("paths", "navigation.position"),
        ("from", from_iso),
    ]);
    format!("{server_base}/signalk/v2/api/history/values?{qs}")
}

pub fn v1_self_track_url(server_base: &str, hours: i64) -> String {
    format!("{server_base}/signalk/v1/api/self/track?timespan={hours}h")
}

pub fn v1_tracks_url(server_base: &str) -> String {
    format!("{server_base}/signalk/v1/api/tracks?context=vessels.self&radius=500000")
}

pub fn v1_vessel_track_url(server_base: &str, vessel_id: &str, hours: i64) -> String {
    let encoded_id = encode_uri_component(vessel_id);
    format!("{server_base}/signalk/v1/api/vessels/{encoded_id}/track?timespan={hours}h")
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{
        dedup_coords, extract_history_coords, extract_track_coords, ms_to_iso8601,
        v1_self_track_url, v1_tracks_url, v1_vessel_track_url, v2_history_url_for_vessel,
        v2_history_url_own_vessel,
    };
    use crate::skrest::http;
    use wasm_bindgen::prelude::*;

    const FETCH_TIMEOUT_MS: u32 = 15_000;

    /// Await one of the three parallel history sources, degrading to `[]`
    /// on any error/timeout/malformed-JSON — mirrors `Promise.allSettled`
    /// plus each `.then()`'s own try/catch-free `!res.ok` early-return.
    async fn coords_or_empty(
        promise: js_sys::Promise,
        parse: impl FnOnce(&str) -> Vec<[f64; 2]>,
    ) -> Vec<[f64; 2]> {
        match http::await_response(promise).await {
            Ok(resp) if resp.ok() => parse(&resp.text),
            _ => Vec::new(),
        }
    }

    /// Fetch the own-vessel track from Signal K (v2 history + v1 in-memory
    /// buffer + `@signalk/tracks` plugin, queried in parallel and merged).
    ///   `historyHours` defaults to 24 on the TS side.
    #[wasm_bindgen(js_name = fetchTrack)]
    pub async fn fetch_track(server_base: String, history_hours: f64) -> Result<JsValue, JsValue> {
        let hours = history_hours.round() as i64; // guard against float values from old localStorage
        let from_iso = ms_to_iso8601(js_sys::Date::now() - (hours as f64) * 3_600_000.0);

        let v2_url = v2_history_url_own_vessel(&server_base, &from_iso);
        let v1_url = v1_self_track_url(&server_base, hours);
        let tracks_url = v1_tracks_url(&server_base);

        // Start all three requests synchronously (before any `.await`) so
        // they fire concurrently, matching the original `Promise.allSettled`.
        let v2_promise = http::start_fetch(
            "GET",
            &v2_url,
            &JsValue::UNDEFINED,
            None,
            Some(FETCH_TIMEOUT_MS),
        )?;
        let v1_promise = http::start_fetch(
            "GET",
            &v1_url,
            &JsValue::UNDEFINED,
            None,
            Some(FETCH_TIMEOUT_MS),
        )?;
        let tracks_promise = http::start_fetch(
            "GET",
            &tracks_url,
            &JsValue::UNDEFINED,
            None,
            Some(FETCH_TIMEOUT_MS),
        )?;

        let v2_coords = coords_or_empty(v2_promise, extract_history_coords).await;
        let v1_coords = coords_or_empty(v1_promise, |t| {
            serde_json::from_str(t)
                .map(|g| extract_track_coords(&g))
                .unwrap_or_default()
        })
        .await;
        let tracks_coords = coords_or_empty(tracks_promise, |t| {
            serde_json::from_str(t)
                .map(|g| extract_track_coords(&g))
                .unwrap_or_default()
        })
        .await;

        // Concatenation order (v2 -> v1 -> tracks) is roughly oldest-first;
        // dedup tolerates overlapping coverage between sources.
        let mut all = v2_coords;
        all.extend(v1_coords);
        all.extend(tracks_coords);
        let result = if all.is_empty() {
            all
        } else {
            dedup_coords(&all)
        };
        serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Fetch position history for an AIS vessel (v2 history + v1 in-memory
    /// track, queried in parallel; `[]` if neither source has data).
    ///   `vesselId` e.g. `urn:mrn:imo:mmsi:123456789`. `historyHours` defaults to 24 on the TS side.
    #[wasm_bindgen(js_name = fetchAisVesselTrack)]
    pub async fn fetch_ais_vessel_track(
        server_base: String,
        vessel_id: String,
        history_hours: f64,
    ) -> Result<JsValue, JsValue> {
        let from_iso = ms_to_iso8601(js_sys::Date::now() - history_hours * 3_600_000.0);
        let v2_url = v2_history_url_for_vessel(&server_base, &vessel_id, &from_iso);
        let v1_url = v1_vessel_track_url(&server_base, &vessel_id, history_hours.round() as i64);

        // The v2 request has no timeout in the original TS (asymmetry preserved).
        let v2_promise = http::start_fetch("GET", &v2_url, &JsValue::UNDEFINED, None, None)?;
        let v1_promise = http::start_fetch(
            "GET",
            &v1_url,
            &JsValue::UNDEFINED,
            None,
            Some(FETCH_TIMEOUT_MS),
        )?;

        let v2_coords = coords_or_empty(v2_promise, extract_history_coords).await;
        let v1_coords = coords_or_empty(v1_promise, |t| {
            serde_json::from_str(t)
                .map(|g| extract_track_coords(&g))
                .unwrap_or_default()
        })
        .await;

        let result = if v2_coords.is_empty() {
            v1_coords
        } else if v1_coords.is_empty() {
            v2_coords
        } else {
            let mut all = v2_coords;
            all.extend(v1_coords);
            dedup_coords(&all)
        };
        serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ms_to_iso8601_epoch() {
        assert_eq!(ms_to_iso8601(0.0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn ms_to_iso8601_known_timestamp() {
        // 2023-11-14T22:13:20.000Z = 1700000000000 ms
        assert_eq!(
            ms_to_iso8601(1_700_000_000_000.0),
            "2023-11-14T22:13:20.000Z"
        );
    }

    #[test]
    fn ms_to_iso8601_round_trips_with_skdata_parser_format() {
        // Same fixed point used by skdata's parse_iso8601_utc_ms tests, both directions.
        assert_eq!(ms_to_iso8601(1500.0), "1970-01-01T00:00:01.500Z");
        assert_eq!(ms_to_iso8601(60_000.0), "1970-01-01T00:01:00.000Z");
    }

    #[test]
    fn extract_track_coords_linestring() {
        let g = json!({ "type": "LineString", "coordinates": [[1.0, 2.0], [3.0, 4.0]] });
        assert_eq!(extract_track_coords(&g), vec![[1.0, 2.0], [3.0, 4.0]]);
    }

    #[test]
    fn extract_track_coords_feature_wraps_geometry() {
        let g = json!({ "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[1.0, 2.0]] } });
        assert_eq!(extract_track_coords(&g), vec![[1.0, 2.0]]);
    }

    #[test]
    fn extract_track_coords_feature_collection_flattens() {
        let g = json!({
            "type": "FeatureCollection",
            "features": [
                { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[1.0, 2.0]] } },
                { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[3.0, 4.0]] } },
            ],
        });
        assert_eq!(extract_track_coords(&g), vec![[1.0, 2.0], [3.0, 4.0]]);
    }

    #[test]
    fn extract_track_coords_multilinestring_flattens() {
        let g = json!({ "type": "MultiLineString", "coordinates": [[[1.0, 2.0]], [[3.0, 4.0], [5.0, 6.0]]] });
        assert_eq!(
            extract_track_coords(&g),
            vec![[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]]
        );
    }

    #[test]
    fn extract_track_coords_filters_malformed_entries() {
        let g = json!({ "type": "LineString", "coordinates": [[1.0, 2.0], ["bad"], [3.0], [5.0, 6.0]] });
        assert_eq!(extract_track_coords(&g), vec![[1.0, 2.0], [5.0, 6.0]]);
    }

    #[test]
    fn extract_track_coords_unknown_type_returns_empty() {
        assert_eq!(
            extract_track_coords(&json!({ "type": "Point", "coordinates": [1.0, 2.0] })),
            Vec::<[f64; 2]>::new()
        );
        assert_eq!(extract_track_coords(&json!(null)), Vec::<[f64; 2]>::new());
        assert_eq!(extract_track_coords(&json!({})), Vec::<[f64; 2]>::new());
    }

    #[test]
    fn dedup_keeps_first_point_unconditionally() {
        assert_eq!(dedup_coords(&[[1.0, 2.0]]), vec![[1.0, 2.0]]);
    }

    #[test]
    fn dedup_drops_points_within_5m() {
        // ~5m threshold in degrees; 1e-6 deg ~ 0.11m, well under threshold.
        let coords = vec![
            [24.0, 60.0],
            [24.0 + 1e-6, 60.0],
            [24.0 + 1e-6, 60.0 + 1e-6],
        ];
        assert_eq!(dedup_coords(&coords), vec![[24.0, 60.0]]);
    }

    #[test]
    fn dedup_keeps_points_beyond_5m() {
        let coords = vec![[24.0, 60.0], [24.001, 60.0]]; // ~55m apart at this latitude
        assert_eq!(dedup_coords(&coords), coords);
    }

    #[test]
    fn extract_history_coords_skips_null_and_missing_fields() {
        let body = json!({
            "data": [
                ["2026-06-29T12:00:00Z", { "longitude": 24.9, "latitude": 60.1 }],
                ["2026-06-29T12:00:01Z", null],
                ["2026-06-29T12:00:02Z", { "longitude": 24.95 }],
            ],
        })
        .to_string();
        assert_eq!(extract_history_coords(&body), vec![[24.9, 60.1]]);
    }

    #[test]
    fn extract_history_coords_malformed_json_returns_empty() {
        assert_eq!(extract_history_coords("not json"), Vec::<[f64; 2]>::new());
        assert_eq!(
            extract_history_coords(r#"{"no_data_key": true}"#),
            Vec::<[f64; 2]>::new()
        );
    }

    #[test]
    fn v2_history_url_own_vessel_param_order() {
        assert_eq!(
            v2_history_url_own_vessel("http://sk.local:3000", "2026-06-29T12:00:00.000Z"),
            "http://sk.local:3000/signalk/v2/api/history/values?paths=navigation.position&from=2026-06-29T12%3A00%3A00.000Z"
        );
    }

    #[test]
    fn v2_history_url_for_vessel_param_order_includes_context_first() {
        assert_eq!(
            v2_history_url_for_vessel("http://sk.local:3000", "urn:mrn:imo:mmsi:230035920", "2026-06-29T12:00:00.000Z"),
            "http://sk.local:3000/signalk/v2/api/history/values?context=vessels.urn%3Amrn%3Aimo%3Ammsi%3A230035920&paths=navigation.position&from=2026-06-29T12%3A00%3A00.000Z"
        );
    }

    #[test]
    fn v1_self_track_url_shape() {
        assert_eq!(
            v1_self_track_url("http://sk.local:3000", 24),
            "http://sk.local:3000/signalk/v1/api/self/track?timespan=24h"
        );
    }

    #[test]
    fn v1_tracks_url_shape() {
        assert_eq!(
            v1_tracks_url("http://sk.local:3000"),
            "http://sk.local:3000/signalk/v1/api/tracks?context=vessels.self&radius=500000"
        );
    }

    #[test]
    fn v1_vessel_track_url_encodes_vessel_id() {
        assert_eq!(
            v1_vessel_track_url("http://sk.local:3000", "urn:mrn:imo:mmsi:230035920", 12),
            "http://sk.local:3000/signalk/v1/api/vessels/urn%3Amrn%3Aimo%3Ammsi%3A230035920/track?timespan=12h"
        );
    }
}
