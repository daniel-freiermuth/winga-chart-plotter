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
    // Shortest signed longitude difference, wrapped into [-180, 180], so a
    // target just across the antimeridian projects a few km away rather
    // than ~40 000 km (a raw delta of ±359.9°).
    let d_lon = (tgt_lon - own_lon + 540.0).rem_euclid(360.0) - 180.0;
    let tgt_x0 = d_lon * M_PER_DEG_LAT * cos_lat;
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

    // Sign of the initial range rate: d/dt |rel_pos|² at t=0 equals
    // 2·dot(rel_pos, rel_vel).  A negative dot product means the target is
    // closing *right now*, even when the true CPA lies inside the first
    // CPA_STEP_S sampling step (where d(0) < d(CPA_STEP_S) would otherwise
    // misclassify the contact as opening).  The target's RoT does not change
    // its velocity direction at t=0, so straight-line velocities suffice.
    let rel_vx = tgt_sog * tgt_cog.sin() - own_vx;
    let rel_vy = tgt_sog * tgt_cog.cos() - own_vy;
    let range_rate_dot = tgt_x0 * rel_vx + tgt_y0 * rel_vy;

    // Convention: a zero range rate (parallel movers at constant range) is
    // treated as opening — the range is not decreasing, so the CPA is "now"
    // and the -1.0 sentinel applies.
    let is_opening = best_step == 0 && range_rate_dot >= 0.0;

    let (best_d_sq, ghost_t) = if best_step == 0 && !is_opening {
        // Closing, but the true CPA falls inside the first sampling step.
        // Analytic linear CPA time t* = −dot(p,v)/|v|², clamped to the first
        // step (a realistic RoT barely bends the track within 10 s; the
        // ghost/range below still use the exact arc).  |v|² > 0 is implied
        // by range_rate_dot < 0.  Guard with the sampled minimum so a
        // pathological hard turn can never worsen the reported CPA.
        let rel_v_sq = rel_vx * rel_vx + rel_vy * rel_vy;
        let t_star = (-range_rate_dot / rel_v_sq).min(CPA_STEP_S);
        let (tx, ty) = target_pos_at(tgt_x0, tgt_y0, tgt_cog, tgt_sog, tgt_rot, t_star);
        let d_star_sq = (tx - own_vx * t_star).powi(2) + (ty - own_vy * t_star).powi(2);
        if d_star_sq < best_d_sq {
            (d_star_sq, t_star)
        } else {
            (best_d_sq, 0.0)
        }
    } else {
        (best_d_sq, best_step as f64 * CPA_STEP_S)
    };

    let cpa_nm = best_d_sq.sqrt() / 1852.0;
    // When best_step == CPA_STEPS the true TCPA exceeds the 2-hour horizon;
    // tcpa_min will naturally evaluate to 120.0 and callers use that sentinel.
    let tcpa_min = if is_opening { -1.0 } else { ghost_t / 60.0 };

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

/// Normalize a longitude to `[-180, 180)`.
fn wrap180(lon: f64) -> f64 {
    (lon + 180.0).rem_euclid(360.0) - 180.0
}

/// Dateline-aware union of two viewport bounds.
///
/// Inputs follow MapLibre's `LngLatBounds` convention: `west <= east`, with
/// longitudes possibly outside `[-180, 180]` when a viewport crosses the
/// antimeridian ("unwrapped"). Longitude extents are arcs on a circle, so the
/// union is the smallest arc covering both — two viewports on either side of
/// the dateline merge across it instead of spanning the globe through
/// Greenwich, which is what a naive `min`/`max` union produces (and that can
/// even exceed 360° when unwrapped and normalized inputs mix).
///
/// Returns `[west, south, east, north, center_lon, center_lat]`.
///
/// `center_lon` is CANONICAL: the arc midpoint normalized to `[-180, 180)`
/// (MapLibre's `LngLat.wrap()` convention — a union centered exactly on the
/// antimeridian reports `-180`). The bounds are expressed AROUND that center:
/// `west = center_lon - span/2`, `east = center_lon + span/2` with
/// `span <= 360`, so `west <= center_lon <= east` always holds and either
/// edge may lie outside `[-180, 180]` (unwrapped). This is the same shape a
/// single MapLibre viewport reports: normalized camera center, bounds
/// unwrapped around it. Latitudes are a plain interval union. A tie between
/// the two covering arcs resolves toward the first viewport (deterministic).
#[allow(clippy::too_many_arguments)]
pub fn union_bounds(
    w0: f64,
    s0: f64,
    e0: f64,
    n0: f64,
    w1: f64,
    s1: f64,
    e1: f64,
    n1: f64,
) -> [f64; 6] {
    let south = s0.min(s1);
    let north = n0.max(n1);

    let span0 = (e0 - w0).clamp(0.0, 360.0);
    let span1 = (e1 - w1).clamp(0.0, 360.0);
    let a = wrap180(w0);
    let b = wrap180(w1);

    // Two candidate covers: start at arc 0's west edge and extend to cover
    // arc 1, or vice versa. The smaller one is the union.
    let cover_a = span0.max((b - a).rem_euclid(360.0) + span1);
    let cover_b = span1.max((a - b).rem_euclid(360.0) + span0);
    let (start, span) = if cover_a <= cover_b {
        (a, cover_a)
    } else {
        (b, cover_b)
    };
    let (start, span) = if span >= 360.0 {
        (-180.0, 360.0)
    } else {
        (start, span)
    };

    // The normalized center is canonical — it decides on which "side" of the
    // wrap the union is represented; the bounds re-anchor around it.
    let center_lon = wrap180(start + span / 2.0);

    [
        center_lon - span / 2.0,
        south,
        center_lon + span / 2.0,
        north,
        center_lon,
        (south + north) / 2.0,
    ]
}

/// Dateline-aware union of two viewport bounds — see [`union_bounds`].
/// Returns `[west, south, east, north, center_lon, center_lat]`.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = unionViewBounds)]
pub fn union_view_bounds(
    w0: f64,
    s0: f64,
    e0: f64,
    n0: f64,
    w1: f64,
    s1: f64,
    e1: f64,
    n1: f64,
) -> Vec<f64> {
    union_bounds(w0, s0, e0, n0, w1, s1, e1, n1).to_vec()
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
    fn union_bounds_same_branch() {
        let u = union_bounds(5.0, 50.0, 15.0, 55.0, 8.0, 48.0, 20.0, 52.0);
        assert_eq!(u, [5.0, 48.0, 20.0, 55.0, 12.5, 51.5]);
    }

    #[test]
    fn union_bounds_merges_across_dateline_with_unwrapped_input() {
        // Pane 0 crosses the antimeridian (MapLibre unwraps: east > 180),
        // pane 1 is normalized on the other side. A naive min/max union spans
        // 365° through Greenwich; the true union is 30° across the dateline.
        let u = union_bounds(170.0, -10.0, 195.0, 10.0, -170.0, -5.0, -160.0, 15.0);
        // Center is canonical (normalized -175); bounds re-anchor around it.
        assert_eq!(u, [-190.0, -10.0, -160.0, 15.0, -175.0, 2.5]);
    }

    #[test]
    fn union_bounds_straddling_panes_pick_the_dateline_gap() {
        // Neither pane crosses on its own; the smaller gap is the dateline.
        // min/max would yield [-179, 179] (358°) centered on Greenwich.
        let u = union_bounds(175.0, 0.0, 179.0, 1.0, -179.0, 0.0, -175.0, 1.0);
        assert_eq!(u[4], -180.0); // exactly on the antimeridian → -180 (LngLat.wrap convention)
        assert_eq!(u[0], -185.0);
        assert_eq!(u[2], -175.0);
    }

    #[test]
    fn union_bounds_adjacent_at_exact_antimeridian_endpoints() {
        // Two arcs meeting exactly at ±180 form one contiguous 40° arc across
        // the dateline — not a 360° wrap the wrong way round.
        let u = union_bounds(-180.0, 0.0, -160.0, 1.0, 160.0, 0.0, 180.0, 1.0);
        assert_eq!(u[4], -180.0);
        assert_eq!(u[0], -200.0);
        assert_eq!(u[2], -160.0);
    }

    #[test]
    fn union_bounds_both_inputs_unwrapped_past_180_in_opposite_directions() {
        // -210 means 150°E, 210 means -150°: both overwound representations
        // collapse to the same 60° Pacific arc. Naive min/max would produce
        // [-210, 210] — a 420° "bbox".
        let u = union_bounds(-210.0, 0.0, -160.0, 1.0, 160.0, 0.0, 210.0, 1.0);
        assert_eq!(u[4], -180.0);
        assert_eq!(u[0], -210.0);
        assert_eq!(u[2], -150.0);
    }

    #[test]
    fn union_bounds_full_turn_winding_is_a_noop() {
        // [360, 370] is [0, 10] wound one full turn — rem_euclid normalizes
        // arbitrary winding counts, so the union is the arc itself.
        let u = union_bounds(0.0, 0.0, 10.0, 1.0, 360.0, 0.0, 370.0, 1.0);
        assert_eq!(u[0], 0.0);
        assert_eq!(u[2], 10.0);
        assert_eq!(u[4], 5.0);
    }

    #[test]
    fn union_bounds_containment_returns_outer() {
        let u = union_bounds(0.0, 0.0, 30.0, 30.0, 10.0, 5.0, 20.0, 25.0);
        assert_eq!(u, [0.0, 0.0, 30.0, 30.0, 15.0, 15.0]);
    }

    #[test]
    fn union_bounds_world_spanning_pane_degrades_to_world() {
        let u = union_bounds(-180.0, -80.0, 180.0, 80.0, 10.0, 0.0, 20.0, 10.0);
        assert_eq!(u[0], -180.0);
        assert_eq!(u[2], 180.0);
    }

    #[test]
    fn union_bounds_identical_inputs_are_a_fixed_point() {
        let u = union_bounds(5.0, 50.0, 15.0, 55.0, 5.0, 50.0, 15.0, 55.0);
        assert_eq!(u, [5.0, 50.0, 15.0, 55.0, 10.0, 52.5]);
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
    fn test_cpa_converging_within_first_step_is_not_opening() {
        // Own: origin, stationary.  Target: 40 m north, heading south (cog=π), 10 m/s.
        // True CPA ≈ 0 m at t = 4 s — inside the first 10 s sampling step.
        // d(0) = 40 m < d(10 s) = 60 m, so the step of minimum sampled range is 0,
        // but the target is closing hard: this must NOT be reported as opening.
        let r = cpa_core(
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            40.0 / M_PER_DEG_LAT,
            std::f64::consts::PI,
            10.0,
            0.0,
        );
        assert!(
            r.tcpa_min >= 0.0,
            "converging target with TCPA < 10 s must not get the opening sentinel, got tcpa_min={}",
            r.tcpa_min
        );
        assert!(
            (r.tcpa_min - 4.0 / 60.0).abs() < 0.05,
            "TCPA should be ~4 s (0.067 min), got {} min",
            r.tcpa_min
        );
        assert!(
            r.cpa_nm < 5.0 / 1852.0,
            "CPA should be ~0 m, not the t=0 range of 40 m, got {} nm",
            r.cpa_nm
        );
    }

    #[test]
    fn test_cpa_parallel_same_velocity_is_opening() {
        // Both vessels heading north at 5 m/s, target 100 m east: constant range,
        // zero range rate.  Convention: range not decreasing → opening sentinel,
        // CPA equals the current distance.
        let r = cpa_core(
            0.0,
            0.0,
            0.0,
            5.0,
            100.0 / M_PER_DEG_LAT,
            0.0,
            0.0,
            5.0,
            0.0,
        );
        assert_eq!(
            r.tcpa_min, -1.0,
            "constant-range parallel movers should be opening"
        );
        assert!(
            (r.cpa_nm - 100.0 / 1852.0).abs() < 0.001,
            "CPA should equal current distance, got {} nm",
            r.cpa_nm
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
    fn test_cpa_across_antimeridian() {
        // Own: 179.95°E on the equator, heading east (cog=π/2) at 5 m/s.
        // Target: 179.95°W (= -179.95), stationary — a true separation of
        // 0.1° of longitude ≈ 11.1 km, directly ahead.  Own ship covers
        // 36 km in the 2 h horizon, so CPA must be ~0.
        // A raw lon delta of -359.9° would instead place the target
        // ~40 000 km away and report a garbage CPA.
        let r = cpa_core(
            179.95,
            0.0,
            std::f64::consts::FRAC_PI_2,
            5.0,
            -179.95,
            0.0,
            0.0,
            0.0,
            0.0,
        );
        assert!(
            r.cpa_nm < 0.1,
            "CPA across the antimeridian should be ~0 nm, got {} nm",
            r.cpa_nm
        );
        assert!(
            r.tcpa_min > 0.0,
            "dead-ahead stationary target must be converging, got tcpa_min={}",
            r.tcpa_min
        );
        // Control: the identical geometry centred on lon 0 must agree.
        let control = cpa_core(
            -0.05,
            0.0,
            std::f64::consts::FRAC_PI_2,
            5.0,
            0.05,
            0.0,
            0.0,
            0.0,
            0.0,
        );
        assert!(
            (r.cpa_nm - control.cpa_nm).abs() < 0.01,
            "antimeridian CPA ({} nm) should match lon-0 control ({} nm)",
            r.cpa_nm,
            control.cpa_nm
        );
        assert!(
            (r.tcpa_min - control.tcpa_min).abs() < 0.2,
            "antimeridian TCPA ({}) should match lon-0 control ({})",
            r.tcpa_min,
            control.tcpa_min
        );

        // ── Ghost-coordinate sanity ──
        // Both vessels should meet near the target's physical location
        // (−179.95° ≡ 180.05° unwrapped), equator.  Use wrapped longitude
        // difference so equivalent antimeridian positions are accepted.
        let wrap = |d: f64| (d + 540.0).rem_euclid(360.0) - 180.0;

        // Latitudes stay on the equator (east-heading, no north/south component).
        assert!(
            r.own_lat.abs() < 0.01,
            "own ghost lat should be near equator, got {}",
            r.own_lat
        );
        assert!(
            r.tgt_lat.abs() < 0.01,
            "tgt ghost lat should be near equator, got {}",
            r.tgt_lat
        );

        // Own ship should reach the target's physical position (≈ -179.95°).
        assert!(
            wrap(r.own_lon - (-179.95)).abs() < 0.02,
            "own ghost lon should be near ±180°, wrapped Δ={} from -179.95°",
            wrap(r.own_lon - (-179.95))
        );
        // Stationary target ghost must stay at its start position.
        assert!(
            wrap(r.tgt_lon - (-179.95)).abs() < 0.02,
            "tgt ghost lon should be near -179.95°, wrapped Δ={}",
            wrap(r.tgt_lon - (-179.95))
        );

        // Ghost latitudes and lon-offsets-from-start must match the control
        // (same geometry shifted 180° in longitude).
        assert!(
            (r.own_lat - control.own_lat).abs() < 0.01,
            "own ghost lat mismatch: antimeridian={} control={}",
            r.own_lat,
            control.own_lat
        );
        assert!(
            (r.tgt_lat - control.tgt_lat).abs() < 0.01,
            "tgt ghost lat mismatch: antimeridian={} control={}",
            r.tgt_lat,
            control.tgt_lat
        );
        // Own-ship lon displacement from start: should be identical in both
        // geometries (≈ 0.1° eastward).
        let own_dlon_am = r.own_lon - 179.95;
        let own_dlon_ctrl = control.own_lon - (-0.05);
        assert!(
            (own_dlon_am - own_dlon_ctrl).abs() < 0.001,
            "own ghost Δlon mismatch: antimeridian={} control={}",
            own_dlon_am,
            own_dlon_ctrl
        );
        // Target lon displacement from own start: identical.
        let tgt_dlon_am = r.tgt_lon - 179.95;
        let tgt_dlon_ctrl = control.tgt_lon - (-0.05);
        assert!(
            (tgt_dlon_am - tgt_dlon_ctrl).abs() < 0.001,
            "tgt ghost Δlon mismatch: antimeridian={} control={}",
            tgt_dlon_am,
            tgt_dlon_ctrl
        );
    }

    #[test]
    fn test_cpa_nan_inputs() {
        let r = gc_compute_cpa(f64::NAN, 0.0, 0.0, 5.0, 0.0, 0.0, 0.0, 5.0, 0.0);
        assert!(r.cpa_nm.is_nan(), "NaN input should propagate to cpa_nm");
    }
}
