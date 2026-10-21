//! Chart resources — `GET /signalk/v2/api/resources/charts` and the
//! MapLibre tile-URL builder. Ported from `buildTileUrl`/`mimeType`/
//! `fetchCharts` in `app/src/lib/signalk-api.ts`.

use super::urlenc::encode_uri_component;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

/// Chart resource `type`. Parsed case-insensitively (providers such as
/// `signalk-charts-provider-simple` pass `MBTiles` metadata through verbatim and
/// match it case-insensitively) and serialized in its canonical spelling.
/// Any value outside the known set becomes [`ChartKind::Unknown`], which
/// serializes as `"unknown"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ChartKind {
    /// XYZ tile template (raster or vector).
    #[serde(rename = "tilelayer")]
    TileLayer,
    /// S-57 ENC converted to vector tiles; `url` is an XYZ template.
    #[serde(rename = "S-57")]
    S57,
    #[serde(rename = "WMS")]
    Wms,
    #[serde(rename = "WMTS")]
    Wmts,
    /// `url` points at a MapLibre style document, not a tile template.
    #[serde(rename = "mapstyleJSON")]
    MapStyleJson,
    /// `url` points at a `TileJSON` document, not a tile template.
    #[serde(rename = "tileJSON")]
    TileJson,
    #[serde(rename = "unknown")]
    Unknown,
}

impl ChartKind {
    fn parse(raw: &str) -> Self {
        match raw.to_ascii_lowercase().as_str() {
            "tilelayer" => Self::TileLayer,
            "s-57" => Self::S57,
            "wms" => Self::Wms,
            "wmts" => Self::Wmts,
            "mapstylejson" => Self::MapStyleJson,
            "tilejson" => Self::TileJson,
            _ => Self::Unknown,
        }
    }
}

impl<'de> Deserialize<'de> for ChartKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(Self::parse(&raw))
    }
}

/// Chart entry as returned by `GET /signalk/v2/api/resources/charts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chart {
    pub identifier: String,
    pub name: String,
    pub description: Option<String>,
    /// Base URL for WMS/WMTS, or XYZ tile template for tilelayer.
    pub url: Option<String>,
    /// "png" | "jpg" | "pbf" etc.
    pub format: String,
    #[serde(rename = "type")]
    pub kind: ChartKind,
    pub minzoom: Option<f64>,
    pub maxzoom: Option<f64>,
    pub scale: Option<f64>,
    pub bounds: Option<[f64; 4]>,
    pub layers: Option<Vec<String>>,
    /// WMS version override, e.g. "1.1.1" or "1.3.0" (default: "1.3.0").
    pub wms_version: Option<String>,
    /// URL to a MapLibre style JSON; when present this is used as the
    /// full map base style — no individual source/layer management needed.
    pub style: Option<String>,
}

pub type ChartRecord = HashMap<String, Chart>;

fn mime_type(format: &str) -> String {
    match format.to_lowercase().as_str() {
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "pbf" => "application/vnd.mapbox-vector-tile".to_string(),
        "webp" => "image/webp".to_string(),
        other => format!("image/{other}"),
    }
}

/// Build a MapLibre-compatible raster tile URL for a chart.
///
/// - tilelayer / S-57 -> resolve relative URL, return as-is (already an XYZ template)
/// - WMS              -> build a GetMap URL with `{bbox-epsg-3857}`
/// - WMTS KVP         -> build a GetTile URL with `{z}/{x}/{y}` tokens
/// - WMTS REST        -> treat as XYZ (the URL already contains tile path tokens)
/// - mapstyleJSON / tileJSON / unknown -> `None` (`url` is not a tile template)
pub fn build_tile_url(chart: &Chart, server_base: &str) -> Option<String> {
    let chart_url = chart.url.as_ref()?;
    let base = if chart_url.starts_with('/') {
        format!("{server_base}{chart_url}")
    } else {
        chart_url.clone()
    };

    match chart.kind {
        ChartKind::Wms => {
            let layers = chart.layers.as_deref().unwrap_or(&[]).join(",");
            let fmt = mime_type(&chart.format);
            let ver = chart.wms_version.as_deref().unwrap_or("1.3.0");
            // CRS parameter name differs between WMS 1.1.x (SRS) and 1.3.0 (CRS).
            let crs_param = if ver.starts_with("1.1") { "SRS" } else { "CRS" };
            let sep = if base.contains('?') { '&' } else { '?' };
            Some(format!(
                "{base}{sep}SERVICE=WMS&VERSION={ver}&REQUEST=GetMap\
                 &{crs_param}=EPSG:3857&BBOX={{bbox-epsg-3857}}\
                 &WIDTH=256&HEIGHT=256\
                 &LAYERS={}\
                 &STYLES=\
                 &FORMAT={}\
                 &TRANSPARENT=TRUE",
                encode_uri_component(&layers),
                encode_uri_component(&fmt),
            ))
        }
        // Detect KVP-style by absence of "{z}" in URL.
        ChartKind::Wmts if !base.contains("{z}") => {
            let layer = chart
                .layers
                .as_ref()
                .and_then(|l| l.first())
                .map_or("", String::as_str);
            let fmt = mime_type(&chart.format);
            let sep = if base.contains('?') { '&' } else { '?' };
            Some(format!(
                "{base}{sep}SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile\
                 &LAYER={}\
                 &TILEMATRIXSET=EPSG:3857&TILEMATRIX={{z}}&TILEROW={{y}}&TILECOL={{x}}\
                 &FORMAT={}",
                encode_uri_component(layer),
                encode_uri_component(&fmt),
            ))
        }
        // REST-style WMTS, tilelayer and S-57 already carry {z}/{x}/{y} tokens.
        ChartKind::Wmts | ChartKind::TileLayer | ChartKind::S57 => Some(base),
        ChartKind::MapStyleJson | ChartKind::TileJson | ChartKind::Unknown => None,
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{Chart, ChartRecord, build_tile_url};
    use crate::skrest::http;
    use wasm_bindgen::prelude::*;

    /// Build a MapLibre-compatible raster tile URL for a chart.
    /// Synchronous — `chart` is a JS object matching the `Chart` shape.
    #[wasm_bindgen(js_name = buildTileUrl)]
    pub fn build_tile_url_js(chart: JsValue, server_base: &str) -> Option<String> {
        let chart: Chart = serde_wasm_bindgen::from_value(chart).ok()?;
        build_tile_url(&chart, server_base)
    }

    /// `GET /signalk/v2/api/resources/charts`
    #[wasm_bindgen(js_name = fetchCharts)]
    pub async fn fetch_charts(server_base: String) -> Result<JsValue, JsValue> {
        let url = format!("{server_base}/signalk/v2/api/resources/charts");
        let resp = http::fetch("GET", &url, &JsValue::UNDEFINED, None, None).await?;
        if !resp.ok() {
            return Err(http::status_error("Charts API error", &resp));
        }
        let charts: ChartRecord = serde_json::from_str(&resp.text)
            .map_err(|e| JsValue::from_str(&format!("Charts API parse error: {e}")))?;
        crate::skrest::to_js_object(&charts)
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

    fn chart(kind: ChartKind, url: &str) -> Chart {
        Chart {
            identifier: "c1".into(),
            name: "Chart 1".into(),
            description: None,
            url: Some(url.into()),
            format: "png".into(),
            kind,
            minzoom: None,
            maxzoom: None,
            scale: None,
            bounds: None,
            layers: None,
            wms_version: None,
            style: None,
        }
    }

    #[test]
    fn tilelayer_passes_through_relative_url() {
        let c = chart(ChartKind::TileLayer, "/charts/foo/{z}/{x}/{y}.png");
        assert_eq!(
            build_tile_url(&c, "http://sk.local:3000"),
            Some("http://sk.local:3000/charts/foo/{z}/{x}/{y}.png".to_string())
        );
    }

    #[test]
    fn tilelayer_absolute_url_used_as_is() {
        let c = chart(
            ChartKind::TileLayer,
            "https://tiles.example/{z}/{x}/{y}.png",
        );
        assert_eq!(
            build_tile_url(&c, "http://sk.local:3000"),
            Some("https://tiles.example/{z}/{x}/{y}.png".to_string())
        );
    }

    #[test]
    fn missing_url_returns_none() {
        let mut c = chart(ChartKind::TileLayer, "");
        c.url = None;
        assert_eq!(build_tile_url(&c, "http://sk.local:3000"), None);
    }

    #[test]
    fn wms_builds_getmap_url_with_crs() {
        let mut c = chart(ChartKind::Wms, "/wms");
        c.layers = Some(vec!["sea".into(), "land".into()]);
        let url = build_tile_url(&c, "http://sk.local:3000").unwrap();
        assert!(
            url.starts_with("http://sk.local:3000/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap")
        );
        assert!(url.contains("&CRS=EPSG:3857&BBOX={bbox-epsg-3857}"));
        assert!(url.contains("&LAYERS=sea%2Cland"));
        assert!(url.contains("&FORMAT=image%2Fpng"));
    }

    #[test]
    fn wms_1_1_uses_srs_param() {
        let mut c = chart(ChartKind::Wms, "/wms");
        c.wms_version = Some("1.1.1".into());
        let url = build_tile_url(&c, "http://sk.local:3000").unwrap();
        assert!(url.contains("VERSION=1.1.1"));
        assert!(url.contains("&SRS=EPSG:3857"));
        assert!(!url.contains("&CRS=EPSG:3857"));
    }

    #[test]
    fn wms_appends_with_ampersand_when_query_already_present() {
        let c = chart(ChartKind::Wms, "/wms?token=abc");
        let url = build_tile_url(&c, "http://sk.local:3000").unwrap();
        assert!(url.starts_with("http://sk.local:3000/wms?token=abc&SERVICE=WMS"));
    }

    #[test]
    fn wmts_kvp_builds_gettile_url() {
        let mut c = chart(ChartKind::Wmts, "/wmts");
        c.layers = Some(vec!["sea".into()]);
        let url = build_tile_url(&c, "http://sk.local:3000").unwrap();
        assert!(url.contains("REQUEST=GetTile"));
        assert!(url.contains("&LAYER=sea"));
        assert!(url.contains("TILEMATRIX={z}&TILEROW={y}&TILECOL={x}"));
    }

    #[test]
    fn wmts_rest_style_passes_through() {
        let c = chart(ChartKind::Wmts, "/wmts/{z}/{x}/{y}.png");
        assert_eq!(
            build_tile_url(&c, "http://sk.local:3000"),
            Some("http://sk.local:3000/wmts/{z}/{x}/{y}.png".to_string())
        );
    }

    #[test]
    fn s57_passes_through_as_xyz_template() {
        let c = chart(ChartKind::S57, "/charts/enc/{z}/{x}/{y}");
        assert_eq!(
            build_tile_url(&c, "http://sk.local:3000"),
            Some("http://sk.local:3000/charts/enc/{z}/{x}/{y}".to_string())
        );
    }

    #[test]
    fn non_template_kinds_have_no_tile_url() {
        for kind in [
            ChartKind::MapStyleJson,
            ChartKind::TileJson,
            ChartKind::Unknown,
        ] {
            let c = chart(kind, "https://example/style.json");
            assert_eq!(build_tile_url(&c, "http://sk.local:3000"), None, "{kind:?}");
        }
    }

    #[test]
    fn chart_kind_parses_case_insensitively_and_serializes_canonically() {
        let cases = [
            ("tilelayer", ChartKind::TileLayer, "tilelayer"),
            ("s-57", ChartKind::S57, "S-57"),
            ("wms", ChartKind::Wms, "WMS"),
            ("Wmts", ChartKind::Wmts, "WMTS"),
            ("MAPSTYLEJSON", ChartKind::MapStyleJson, "mapstyleJSON"),
            ("tileJSON", ChartKind::TileJson, "tileJSON"),
            ("WTMS", ChartKind::Unknown, "unknown"),
            ("", ChartKind::Unknown, "unknown"),
        ];
        for (raw, kind, canonical) in cases {
            let parsed: ChartKind = serde_json::from_value(serde_json::json!(raw)).unwrap();
            assert_eq!(parsed, kind, "{raw}");
            assert_eq!(
                serde_json::to_value(parsed).unwrap(),
                serde_json::json!(canonical)
            );
            // Canonical output must round-trip (fetchCharts -> JS -> buildTileUrl).
            let again: ChartKind = serde_json::from_value(serde_json::json!(canonical)).unwrap();
            assert_eq!(again, kind);
        }
    }

    #[test]
    fn chart_kind_rejects_non_string() {
        assert!(serde_json::from_value::<ChartKind>(serde_json::json!(3)).is_err());
    }

    #[test]
    fn mime_type_known_and_fallback() {
        assert_eq!(mime_type("PNG"), "image/png");
        assert_eq!(mime_type("jpeg"), "image/jpeg");
        assert_eq!(mime_type("pbf"), "application/vnd.mapbox-vector-tile");
        assert_eq!(mime_type("tiff"), "image/tiff");
    }

    #[test]
    fn chart_deserializes_camel_case_and_type_field() {
        let json = r#"{
            "identifier": "noaa", "name": "NOAA RNC", "format": "png", "type": "WMS",
            "wmsVersion": "1.1.1", "layers": ["a", "b"]
        }"#;
        let c: Chart = serde_json::from_str(json).unwrap();
        assert_eq!(c.kind, ChartKind::Wms);
        assert_eq!(c.wms_version, Some("1.1.1".to_string()));
        assert_eq!(c.layers, Some(vec!["a".to_string(), "b".to_string()]));
        assert_eq!(c.description, None);
    }
}
