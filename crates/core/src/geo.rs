//! Great-circle navigation math, exposed to JS via `wasm_bindgen`.
//!
//! Ported verbatim from `app/src/lib/geoMath.ts` per the architecture rule
//! that all coordinate math goes through Rust, never raw lon/lat arithmetic
//! in TypeScript. Each public `gc_*` function has a pure, host-testable
//! core (no wasm dependency) plus a thin `#[wasm_bindgen]` wrapper.

use wasm_bindgen::prelude::*;

/// Great-circle bearing from A to B, in degrees `[0, 360)`.
fn bearing_deg(lon_a: f64, lat_a: f64, lon_b: f64, lat_b: f64) -> f64 {
    let phi1 = lat_a.to_radians();
    let phi2 = lat_b.to_radians();
    let delta_lambda = (lon_b - lon_a).to_radians();
    let y = delta_lambda.sin() * phi2.cos();
    let x = phi1.cos() * phi2.sin() - phi1.sin() * phi2.cos() * delta_lambda.cos();
    (y.atan2(x).to_degrees() + 360.0) % 360.0
}

/// Great-circle distance between two points, in nautical miles.
fn distance_nm(lon_a: f64, lat_a: f64, lon_b: f64, lat_b: f64) -> f64 {
    const R_NM: f64 = 3440.065;
    let phi1 = lat_a.to_radians();
    let phi2 = lat_b.to_radians();
    let delta_phi = (lat_b - lat_a).to_radians();
    let delta_lambda = (lon_b - lon_a).to_radians();
    let a = (delta_phi / 2.0).sin().powi(2)
        + phi1.cos() * phi2.cos() * (delta_lambda / 2.0).sin().powi(2);
    2.0 * a.sqrt().atan2((1.0 - a).sqrt()) * R_NM
}

/// Densified great-circle line between two points.
///
/// Returns `[lon, lat]` coordinate pairs with continuous longitude
/// (unwrapped across the antimeridian).
fn line_coords(lon_a: f64, lat_a: f64, lon_b: f64, lat_b: f64, segments: u32) -> Vec<(f64, f64)> {
    let phi1 = lat_a.to_radians();
    let lambda1 = lon_a.to_radians();
    let phi2 = lat_b.to_radians();
    let lambda2 = lon_b.to_radians();

    // Total angular distance.
    let delta_sigma = 2.0
        * ((((phi2 - phi1) / 2.0).sin().powi(2)
            + phi1.cos() * phi2.cos() * ((lambda2 - lambda1) / 2.0).sin().powi(2))
        .sqrt())
        .asin();

    if delta_sigma < 1e-10 {
        return vec![(lon_a, lat_a), (lon_b, lat_b)];
    }

    let mut coords = Vec::with_capacity(segments as usize + 1);
    let mut prev_lambda = lambda1;

    for i in 0..=segments {
        let f = f64::from(i) / f64::from(segments);
        let a = ((1.0 - f) * delta_sigma).sin() / delta_sigma.sin();
        let b = (f * delta_sigma).sin() / delta_sigma.sin();
        let x = a * phi1.cos() * lambda1.cos() + b * phi2.cos() * lambda2.cos();
        let y = a * phi1.cos() * lambda1.sin() + b * phi2.cos() * lambda2.sin();
        let z = a * phi1.sin() + b * phi2.sin();
        let phi = z.atan2((x * x + y * y).sqrt());
        let lambda_raw = y.atan2(x);
        // Unwrap longitude.
        let diff = lambda_raw - prev_lambda;
        let lambda = prev_lambda + diff
            - (diff / (2.0 * std::f64::consts::PI)).round() * 2.0 * std::f64::consts::PI;
        prev_lambda = lambda;
        coords.push((lambda.to_degrees(), phi.to_degrees()));
    }
    coords
}

/// Great-circle bearing from A to B, in degrees `[0, 360)`.
#[wasm_bindgen(js_name = gcBearingDeg)]
pub fn gc_bearing_deg(lon_a: f64, lat_a: f64, lon_b: f64, lat_b: f64) -> f64 {
    bearing_deg(lon_a, lat_a, lon_b, lat_b)
}

/// Great-circle distance between two points, in nautical miles.
#[wasm_bindgen(js_name = gcDistanceNm)]
pub fn gc_distance_nm(lon_a: f64, lat_a: f64, lon_b: f64, lat_b: f64) -> f64 {
    distance_nm(lon_a, lat_a, lon_b, lat_b)
}

/// Densified great-circle line between two points, as `[lon, lat]` pairs
/// with continuous (antimeridian-unwrapped) longitude.
#[wasm_bindgen(js_name = gcLine)]
pub fn gc_line(
    lon_a: f64,
    lat_a: f64,
    lon_b: f64,
    lat_b: f64,
    segments: u32,
) -> Result<JsValue, JsValue> {
    let coords = line_coords(lon_a, lat_a, lon_b, lat_b, segments);
    serde_wasm_bindgen::to_value(&coords).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearing_due_north() {
        let b = bearing_deg(0.0, 0.0, 0.0, 1.0);
        assert!(b.abs() < 1e-6, "expected ~0°, got {b}");
    }

    #[test]
    fn bearing_due_east() {
        let b = bearing_deg(0.0, 0.0, 1.0, 0.0);
        assert!((b - 90.0).abs() < 1e-6, "expected ~90°, got {b}");
    }

    #[test]
    fn bearing_wraps_into_0_360() {
        let b = bearing_deg(0.0, 0.0, -1.0, 0.0);
        assert!((b - 270.0).abs() < 1e-6, "expected ~270°, got {b}");
    }

    #[test]
    fn distance_one_degree_latitude() {
        // 1° of latitude along a meridian ≈ 60.04 nm.
        let d = distance_nm(0.0, 0.0, 0.0, 1.0);
        assert!((d - 60.04).abs() < 0.01, "expected ~60.04 nm, got {d}");
    }

    #[test]
    fn distance_same_point_is_zero() {
        let d = distance_nm(10.75, 59.91, 10.75, 59.91);
        assert!(d.abs() < 1e-9, "expected 0, got {d}");
    }

    #[test]
    fn line_degenerate_same_point_returns_endpoints_only() {
        let coords = line_coords(10.0, 50.0, 10.0, 50.0, 64);
        assert_eq!(coords, vec![(10.0, 50.0), (10.0, 50.0)]);
    }

    #[test]
    fn line_endpoints_match_inputs() {
        let coords = line_coords(0.0, 0.0, 10.0, 10.0, 8);
        let (first_lon, first_lat) = coords[0];
        let (last_lon, last_lat) = *coords.last().unwrap();
        assert!((first_lon - 0.0).abs() < 1e-6);
        assert!((first_lat - 0.0).abs() < 1e-6);
        assert!((last_lon - 10.0).abs() < 1e-6);
        assert!((last_lat - 10.0).abs() < 1e-6);
    }

    #[test]
    fn line_unwraps_across_antimeridian_without_jumping() {
        // Crossing the antimeridian eastward: 179°E to 179°W (== -179°).
        let coords = line_coords(179.0, 0.0, -179.0, 0.0, 32);
        for pair in coords.windows(2) {
            let (lon_prev, _) = pair[0];
            let (lon_next, _) = pair[1];
            assert!(
                (lon_next - lon_prev).abs() < 10.0,
                "longitude jumped discontinuously: {lon_prev} -> {lon_next}"
            );
        }
        // Continuous unwrapping should carry longitude past 180°, not snap to -179°.
        let (last_lon, _) = *coords.last().unwrap();
        assert!(
            (last_lon - 181.0).abs() < 1e-6,
            "expected unwrapped longitude ~181°, got {last_lon}"
        );
    }
}
