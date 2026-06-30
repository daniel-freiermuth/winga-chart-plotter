//! Rich per-vessel metadata — `GET /signalk/v1/api/vessels`. Ported from
//! `fetchVesselInfo` in `app/src/lib/signalk-api.ts`.
//!
//! The v1 snapshot's per-vessel shape is large and only a handful of leaves
//! are used here, so (matching the original TS, which inlines an ad-hoc
//! subset type rather than the full `signalk` crate `V1Vessel`) extraction
//! walks the raw [`serde_json::Value`] tree directly instead of deserialising
//! into a fully-typed struct.

use serde::Serialize;
use serde_json::Value as Json;
use std::collections::HashMap;

/// Subset of a vessel's static/design data worth surfacing in the UI.
/// Every field is only ever populated when the source value is present
/// (and, for strings, non-empty) — mirrors the original's sparse-object
/// construction so absent fields are omitted from the JS object entirely
/// rather than appearing as `null`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VesselInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callsign: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callsign_hf: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipper_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nav_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ship_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beam_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub air_height_m: Option<f64>,
}

/// Non-empty string at a dotted path, e.g. `nested_str(v, &["communication", "callsignVhf"])`.
/// Matches the original's truthy `if (v.foo)` checks — an empty string is
/// treated as absent, not as a (useless) present-but-blank value.
fn nested_str(root: &Json, path: &[&str]) -> Option<String> {
    let mut cur = root;
    for key in path {
        cur = cur.get(key)?;
    }
    cur.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// Number at a dotted path. Matches the original's `!== undefined` /
/// `typeof … === 'number'` checks — `0` is kept, only absence/wrong-type drops it.
fn nested_f64(root: &Json, path: &[&str]) -> Option<f64> {
    let mut cur = root;
    for key in path {
        cur = cur.get(key)?;
    }
    cur.as_f64()
}

/// Extract the chart-relevant subset of one vessel's v1 snapshot.
pub fn extract_vessel_info(v: &Json) -> VesselInfo {
    let draft = nested_f64(v, &["design", "draft", "value", "current"])
        .or_else(|| nested_f64(v, &["design", "draft", "value", "maximum"]));

    VesselInfo {
        name: nested_str(v, &["name"]),
        port: nested_str(v, &["port"]),
        flag: nested_str(v, &["flag"]),
        callsign: nested_str(v, &["communication", "callsignVhf"]),
        callsign_hf: nested_str(v, &["communication", "callsignHf"]),
        skipper_name: nested_str(v, &["communication", "skipperName"]),
        nav_state: nested_str(v, &["navigation", "state", "value"]),
        ship_type: nested_str(v, &["design", "aisShipType", "value", "name"]),
        length_m: nested_f64(v, &["design", "length", "value", "overall"]),
        beam_m: nested_f64(v, &["design", "beam", "value"]),
        draft_m: draft,
        air_height_m: nested_f64(v, &["design", "airHeight", "value"]),
    }
}

/// Extract chart-relevant info for every vessel in a v1 `/vessels` snapshot,
/// keyed by URN (matching the original's `Map<string, VesselInfo>`).
pub fn extract_all(data: &Json) -> HashMap<String, VesselInfo> {
    let Some(obj) = data.as_object() else {
        return HashMap::new();
    };
    obj.iter()
        .map(|(urn, v)| (urn.clone(), extract_vessel_info(v)))
        .collect()
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::extract_all;
    use crate::skrest::http;
    use wasm_bindgen::prelude::*;

    /// `GET /signalk/v1/api/vessels` → `Map<string, VesselInfo>`.
    /// Returns an empty `Map` on a non-OK response (matches the original,
    /// which never throws here — vessel-info enrichment is best-effort).
    #[wasm_bindgen(js_name = fetchVesselInfo)]
    pub async fn fetch_vessel_info(server_base: String) -> Result<JsValue, JsValue> {
        let url = format!("{server_base}/signalk/v1/api/vessels");
        let resp = http::fetch("GET", &url, &JsValue::UNDEFINED, None, None).await?;
        if !resp.ok() {
            return serde_wasm_bindgen::to_value(&std::collections::HashMap::<String, ()>::new())
                .map_err(|e| JsValue::from_str(&e.to_string()));
        }
        let data: serde_json::Value = serde_json::from_str(&resp.text)
            .map_err(|e| JsValue::from_str(&format!("Vessels API parse error: {e}")))?;
        let info = extract_all(&data);
        // Genuine `Map` return (the original builds one explicitly) — plain
        // `to_value` is correct here, unlike the Record-shaped REST resources.
        serde_wasm_bindgen::to_value(&info).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_full_vessel() {
        let v = json!({
            "name": "Disen",
            "port": "Stockholm",
            "flag": "SE",
            "communication": {
                "callsignVhf": "SM1234",
                "callsignHf": "SM5678",
                "skipperName": "Daniel"
            },
            "navigation": { "state": { "value": "motoring" } },
            "design": {
                "aisShipType": { "value": { "name": "Sailing" } },
                "length": { "value": { "overall": 10.5 } },
                "beam": { "value": 3.2 },
                "draft": { "value": { "current": 1.8, "maximum": 2.1 } },
                "airHeight": { "value": 16.0 }
            }
        });
        let info = extract_vessel_info(&v);
        assert_eq!(info.name, Some("Disen".into()));
        assert_eq!(info.port, Some("Stockholm".into()));
        assert_eq!(info.flag, Some("SE".into()));
        assert_eq!(info.callsign, Some("SM1234".into()));
        assert_eq!(info.callsign_hf, Some("SM5678".into()));
        assert_eq!(info.skipper_name, Some("Daniel".into()));
        assert_eq!(info.nav_state, Some("motoring".into()));
        assert_eq!(info.ship_type, Some("Sailing".into()));
        assert_eq!(info.length_m, Some(10.5));
        assert_eq!(info.beam_m, Some(3.2));
        // current takes precedence over maximum.
        assert_eq!(info.draft_m, Some(1.8));
        assert_eq!(info.air_height_m, Some(16.0));
    }

    #[test]
    fn falls_back_to_max_draft_when_no_current() {
        let v = json!({ "design": { "draft": { "value": { "maximum": 2.1 } } } });
        assert_eq!(extract_vessel_info(&v).draft_m, Some(2.1));
    }

    #[test]
    fn empty_strings_are_treated_as_absent() {
        let v = json!({ "name": "", "port": "Stockholm" });
        let info = extract_vessel_info(&v);
        assert_eq!(info.name, None);
        assert_eq!(info.port, Some("Stockholm".into()));
    }

    #[test]
    fn zero_valued_numbers_are_kept() {
        let v = json!({ "design": { "beam": { "value": 0.0 } } });
        assert_eq!(extract_vessel_info(&v).beam_m, Some(0.0));
    }

    #[test]
    fn missing_fields_yield_default() {
        let v = json!({});
        assert_eq!(extract_vessel_info(&v), VesselInfo::default());
    }

    #[test]
    fn extract_all_keys_by_urn() {
        let data = json!({
            "vessels.urn:mrn:imo:mmsi:230035920": { "name": "Disen" },
            "vessels.urn:mrn:imo:mmsi:265547230": { "name": "Other" }
        });
        let map = extract_all(&data);
        assert_eq!(map.len(), 2);
        assert_eq!(
            map.get("vessels.urn:mrn:imo:mmsi:230035920").unwrap().name,
            Some("Disen".into())
        );
    }

    #[test]
    fn extract_all_handles_non_object_input() {
        assert!(extract_all(&json!(null)).is_empty());
    }
}
