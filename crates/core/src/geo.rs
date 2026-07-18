//! Great-circle navigation math, exposed to JS via `wasm_bindgen`.
//!
//! Ported verbatim from `app/src/lib/geoMath.ts` per the architecture rule
//! that all coordinate math goes through Rust, never raw lon/lat arithmetic
//! in TypeScript. Each public `gc_*` function has a pure, host-testable
//! core (no wasm dependency) plus a thin `#[wasm_bindgen]` wrapper.

use wasm_bindgen::prelude::*;

/// Meters per degree of latitude (WGS-84 mean meridian).
const M_PER_DEG_LAT: f64 = 111_319.0;
/// Number of 10-second steps covering a 2-hour CPA horizon.
const CPA_STEPS: usize = 720;
/// Duration of each CPA integration step, in seconds.
const CPA_STEP_S: f64 = 10.0;

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

/// Result of a CPA (Closest Point of Approach) computation.
#[wasm_bindgen]
pub struct CpaResult {
    /// CPA distance in nautical miles.
    pub cpa_nm: f64,
    /// Minutes to CPA.  Sentinel values:
    ///   -1.0  = opening (vessels already diverging — CPA is now)
    ///  120.0  = capped  (true TCPA > 2 h; ghost positions are at the 2 h mark)
    pub tcpa_min: f64,
    /// Own vessel's projected longitude at TCPA (or 2 h mark, or current if opening).
    pub own_lon: f64,
    /// Own vessel's projected latitude at TCPA (or 2 h mark, or current if opening).
    pub own_lat: f64,
    /// Target's projected longitude at TCPA (or 2 h mark, or current if opening).
    pub tgt_lon: f64,
    /// Target's projected latitude at TCPA (or 2 h mark, or current if opening).
    pub tgt_lat: f64,
}

/// Analytic position of a (possibly turning) vessel at time `t_s` seconds.
///
/// Uses a local flat-earth coordinate system (east = +x, north = +y, metres).
/// `cog` = heading from north clockwise (radians). `sog` = speed (m/s).
/// `rot` = rate of turn (rad/s, positive = turning right).
///
/// Arc integrals when `rot` ≠ 0:
///   x(t) = x0 + (sog/rot) · [cos(cog) − cos(cog + rot·t)]
///   y(t) = y0 + (sog/rot) · [sin(cog + rot·t) − sin(cog)]
fn target_pos_at(x0: f64, y0: f64, cog: f64, sog: f64, rot: f64, t_s: f64) -> (f64, f64) {
    if rot.abs() < 1e-5 {
        (x0 + sog * cog.sin() * t_s, y0 + sog * cog.cos() * t_s)
    } else {
        let heading_t = cog + rot * t_s;
        let x = x0 + (sog / rot) * (cog.cos() - heading_t.cos());
        let y = y0 + (sog / rot) * (heading_t.sin() - cog.sin());
        (x, y)
    }
}

/// Pure CPA computation.  Own vessel is assumed to maintain a linear track;
/// the target may follow a curved arc described by `tgt_rot` (rad/s).
///
/// Integrates at [`CPA_STEP_S`]-second intervals over a [`CPA_STEPS`]-step
/// (2 hour) horizon.  Returns the [`CpaResult`] at the step of minimum range.
#[allow(clippy::too_many_arguments)]
fn cpa_core(
    own_lon: f64,
    own_lat: f64,
    own_cog: f64,
    own_sog: f64,
    tgt_lon: f64,
    tgt_lat: f64,
    tgt_cog: f64,
    tgt_sog: f64,
    tgt_rot: f64,
) -> CpaResult {
    let cos_lat = (own_lat * std::f64::consts::PI / 180.0).cos();
    let tgt_x0 = (tgt_lon - own_lon) * M_PER_DEG_LAT * cos_lat;
    let tgt_y0 = (tgt_lat - own_lat) * M_PER_DEG_LAT;

    let own_vx = own_sog * own_cog.sin();
    let own_vy = own_sog * own_cog.cos();

    let mut best_d_sq = f64::INFINITY;
    let mut best_step: usize = 0;

    for step in 0..=CPA_STEPS {
        let t = step as f64 * CPA_STEP_S;
        let ox = own_vx * t;
        let oy = own_vy * t;
        let (tx, ty) = target_pos_at(tgt_x0, tgt_y0, tgt_cog, tgt_sog, tgt_rot, t);
        let d_sq = (tx - ox).powi(2) + (ty - oy).powi(2);
        if d_sq < best_d_sq {
            best_d_sq = d_sq;
            best_step = step;
        }
    }

    let cpa_nm = best_d_sq.sqrt() / 1852.0;
    let is_opening = best_step == 0;
    // When best_step == CPA_STEPS the true TCPA exceeds the 2-hour horizon;
    // tcpa_min will naturally evaluate to 120.0 and callers use that sentinel.
    let tcpa_min = if is_opening {
        -1.0
    } else {
        best_step as f64 * CPA_STEP_S / 60.0
    };

    let ghost_t = if is_opening {
        0.0
    } else {
        best_step as f64 * CPA_STEP_S
    };
    let own_gx = own_vx * ghost_t;
    let own_gy = own_vy * ghost_t;
    let (tgt_gx, tgt_gy) = target_pos_at(tgt_x0, tgt_y0, tgt_cog, tgt_sog, tgt_rot, ghost_t);

    CpaResult {
        cpa_nm,
        tcpa_min,
        own_lon: own_lon + own_gx / (M_PER_DEG_LAT * cos_lat),
        own_lat: own_lat + own_gy / M_PER_DEG_LAT,
        tgt_lon: own_lon + tgt_gx / (M_PER_DEG_LAT * cos_lat),
        tgt_lat: own_lat + tgt_gy / M_PER_DEG_LAT,
    }
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

/// Compute CPA between own vessel (linear track, no RoT) and a target (arc track via RoT).
///
/// All angles in radians; SOG in m/s; RoT in rad/s (NaN → treated as 0).
/// Returns `NaN` in `cpa_nm` when any essential positional input
/// (own/tgt lon/lat/cog/sog) is NaN.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = gcComputeCpa)]
pub fn gc_compute_cpa(
    own_lon: f64,
    own_lat: f64,
    own_cog_rad: f64,
    own_sog_ms: f64,
    tgt_lon: f64,
    tgt_lat: f64,
    tgt_cog_rad: f64,
    tgt_sog_ms: f64,
    tgt_rot_rad_s: f64,
) -> CpaResult {
    if [
        own_lon,
        own_lat,
        own_cog_rad,
        own_sog_ms,
        tgt_lon,
        tgt_lat,
        tgt_cog_rad,
        tgt_sog_ms,
    ]
    .iter()
    .any(|v| v.is_nan())
    {
        return CpaResult {
            cpa_nm: f64::NAN,
            tcpa_min: f64::NAN,
            own_lon: f64::NAN,
            own_lat: f64::NAN,
            tgt_lon: f64::NAN,
            tgt_lat: f64::NAN,
        };
    }
    let rot = if tgt_rot_rad_s.is_nan() {
        0.0
    } else {
        tgt_rot_rad_s
    };
    cpa_core(
        own_lon,
        own_lat,
        own_cog_rad,
        own_sog_ms,
        tgt_lon,
        tgt_lat,
        tgt_cog_rad,
        tgt_sog_ms,
        rot,
    )
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

    #[test]
    fn test_cpa_converging_no_rot() {
        // Own: origin, heading north (cog=0), 5 m/s.
        // Target: 100 m east, 1000 m north, heading south (cog=π), 5 m/s.
        // Closest approach at t≈100 s: own at (0, 500 m), target at (100 m, 500 m) → CPA = 100 m.
        let r = cpa_core(
            0.0,
            0.0,
            0.0,
            5.0,
            100.0 / M_PER_DEG_LAT,
            1000.0 / M_PER_DEG_LAT,
            std::f64::consts::PI,
            5.0,
            0.0,
        );
        assert!(
            (r.cpa_nm - 100.0 / 1852.0).abs() < 0.001,
            "CPA should be ~100 m, got {} nm",
            r.cpa_nm
        );
        assert!(
            (r.tcpa_min - 100.0 / 60.0).abs() < 0.2,
            "TCPA should be ~1.67 min, got {}",
            r.tcpa_min
        );
        assert!(r.tcpa_min > 0.0, "should be converging");
    }

    #[test]
    fn test_cpa_diverging() {
        // Own: origin, heading north; Target: 100 m east, 500 m south, heading south (opening).
        let r = cpa_core(
            0.0,
            0.0,
            0.0,
            5.0,
            100.0 / M_PER_DEG_LAT,
            -500.0 / M_PER_DEG_LAT,
            std::f64::consts::PI,
            5.0,
            0.0,
        );
        assert_eq!(r.tcpa_min, -1.0, "should be opening sentinel");
        let expected_nm = (100.0_f64.powi(2) + 500.0_f64.powi(2)).sqrt() / 1852.0;
        assert!(
            (r.cpa_nm - expected_nm).abs() < 0.001,
            "CPA should equal current distance, got {} nm (expected {} nm)",
            r.cpa_nm,
            expected_nm
        );
    }

    #[test]
    fn test_cpa_beyond_2h() {
        // Slow closing — target 10 km away, combined closing speed 0.5 m/s → ETA ≈ 20 000 s >> 7 200 s.
        let r = cpa_core(
            0.0,
            0.0,
            0.0,
            0.1,
            0.0,
            10_000.0 / M_PER_DEG_LAT,
            std::f64::consts::PI,
            0.4,
            0.0,
        );
        assert_eq!(r.tcpa_min, 120.0, "should be capped at 2 h sentinel");
    }

    #[test]
    fn test_cpa_rot_curves_track() {
        // Own: origin, heading north.  Target: 50 m east, 500 m north, heading south.
        // Negative RoT (−0.05 rad/s) = turning left when southbound = turning eastward,
        // away from the own ship's track → CPA must be larger than the straight-line case.
        let linear = cpa_core(
            0.0,
            0.0,
            0.0,
            5.0,
            50.0 / M_PER_DEG_LAT,
            500.0 / M_PER_DEG_LAT,
            std::f64::consts::PI,
            5.0,
            0.0,
        );
        let curved = cpa_core(
            0.0,
            0.0,
            0.0,
            5.0,
            50.0 / M_PER_DEG_LAT,
            500.0 / M_PER_DEG_LAT,
            std::f64::consts::PI,
            5.0,
            -0.05,
        );
        assert!(
            curved.cpa_nm > linear.cpa_nm,
            "RoT turning away should increase CPA: linear={} curved={}",
            linear.cpa_nm,
            curved.cpa_nm
        );
    }

    #[test]
    fn test_cpa_nan_inputs() {
        let r = gc_compute_cpa(f64::NAN, 0.0, 0.0, 5.0, 0.0, 0.0, 0.0, 5.0, 0.0);
        assert!(r.cpa_nm.is_nan(), "NaN input should propagate to cpa_nm");
    }
}
