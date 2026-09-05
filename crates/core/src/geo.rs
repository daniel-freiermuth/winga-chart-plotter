//! Great-circle navigation math, exposed to JS via `wasm_bindgen`.
//!
//! Ported verbatim from `app/src/lib/geoMath.ts` per the architecture rule
//! that all coordinate math goes through Rust, never raw lon/lat arithmetic
//! in TypeScript. Each public `gc_*` function has a pure, host-testable
//! core (no wasm dependency) plus a thin `#[wasm_bindgen]` wrapper.

use serde::Serialize;
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

    // Total angular distance (clamp to 1.0 so near-antipodal
    // floating-point overshoot cannot produce NaN from asin).
    let h = ((phi2 - phi1) / 2.0).sin().powi(2)
        + phi1.cos() * phi2.cos() * ((lambda2 - lambda1) / 2.0).sin().powi(2);
    let delta_sigma = 2.0 * h.min(1.0).sqrt().asin();

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

// ---------------------------------------------------------------------------
// Track / route coordinate processing
//
// Ported from `app/src/lib/trackProcessing.ts` (ADR-011 in `KNOWLEDGE_BASE.md`:
// batched at data-change frequency — called once per track/route update, never
// per animation frame). `buildTrackGradient` stays in TS: it builds a MapLibre
// style expression, not geo math.
// ---------------------------------------------------------------------------

/// Haversine distance in metres between two points.
fn haversine_meters(lon_a: f64, lat_a: f64, lon_b: f64, lat_b: f64) -> f64 {
    const R_M: f64 = 6_371_000.0;
    let phi1 = lat_a.to_radians();
    let phi2 = lat_b.to_radians();
    let d_phi = (lat_b - lat_a).to_radians();
    let d_lambda = (lon_b - lon_a).to_radians();
    let h = (d_phi / 2.0).sin().powi(2) + phi1.cos() * phi2.cos() * (d_lambda / 2.0).sin().powi(2);
    2.0 * R_M * h.min(1.0).sqrt().asin()
}

/// GC-densify a segment between two points, one point per ~50 km of arc.
///
/// Returns intermediate points (excluding the start) plus the exact endpoint; for
/// segments under ~50 km this is a cheap no-op returning just `[(lon2, lat2)]`.
/// Longitude continuity is maintained via progressive unwrapping from `lon1`.
///
/// Accepts longitudes outside `[-180, 180]` provided `|lon2 - lon1| <= 180°` (both
/// endpoints on the same side of any antimeridian crossing — callers pre-split at
/// crossings via [`split_at_antimeridian`]).
///
/// Uses spherical SLERP so intermediate points are exactly on the great circle.
/// The exact endpoint is pushed last to prevent floating-point drift accumulation.
fn densify_by_distance(lon1: f64, lat1: f64, lon2: f64, lat2: f64) -> Vec<(f64, f64)> {
    const R_M: f64 = 6_371_000.0;
    let phi1 = lat1.to_radians();
    let lambda1 = lon1.to_radians();
    let phi2 = lat2.to_radians();
    let lambda2 = lon2.to_radians();
    let cos_d = phi1.sin() * phi2.sin() + phi1.cos() * phi2.cos() * (lambda2 - lambda1).cos();
    let d = cos_d.clamp(-1.0, 1.0).acos();
    let n_segs = ((d * R_M / 50_000.0).ceil() as usize).max(1);
    if n_segs == 1 || d < 1e-9 {
        return vec![(lon2, lat2)];
    }
    let sin_d = d.sin();
    if sin_d.abs() < 1e-6 {
        // Near-antipodal or exactly antipodal: the great circle is undefined
        // or the SLERP division by sin_d amplifies rounding error beyond the
        // signal (at sin_d ≈ 1e-8, the ~1e8 amplification factor collapses
        // intermediate points into two endpoint clusters). 1e-6 corresponds
        // to ~6.4 m of arc — any real route leg shorter than that is
        // effectively a point and the straight fallback is fine; any
        // near-antipodal leg where sin_d < 1e-6 due to floating-point
        // rounding of the cos_d sum (see the nonzero-latitude test) is
        // caught here instead of producing garbage SLERP output.
        return vec![(lon2, lat2)];
    }
    let mut out = Vec::with_capacity(n_segs);
    let mut prev_lambda = lambda1;
    for i in 1..n_segs {
        let f = i as f64 / n_segs as f64;
        let a = ((1.0 - f) * d).sin() / sin_d;
        let b = (f * d).sin() / sin_d;
        let x = a * phi1.cos() * lambda1.cos() + b * phi2.cos() * lambda2.cos();
        let y = a * phi1.cos() * lambda1.sin() + b * phi2.cos() * lambda2.sin();
        let z = a * phi1.sin() + b * phi2.sin();
        let phi_i = z.atan2((x * x + y * y).sqrt());
        let lambda_i_raw = y.atan2(x);
        // Unwrap relative to the previous intermediate point so longitude stays continuous.
        let diff = lambda_i_raw - prev_lambda;
        let lambda_i = prev_lambda + diff
            - (diff / (2.0 * std::f64::consts::PI)).round() * 2.0 * std::f64::consts::PI;
        prev_lambda = lambda_i;
        out.push((lambda_i.to_degrees(), phi_i.to_degrees()));
    }
    out.push((lon2, lat2)); // exact endpoint — avoids floating-point drift accumulation
    out
}

/// Split raw `[-180, 180]` coordinates at antimeridian crossings.
///
/// A crossing is detected when `|lon[i] - lon[i-1]| > 180°`. At each crossing the
/// pre-crossing point is duplicated into the new segment, shifted ±360° to place it
/// on the far side of the antimeridian. This handover keeps adjacent segments
/// visually connected at the crossing.
///
/// Precondition: input coordinates are in `[-180, 180]` (as Signal K provides
/// them). Postcondition: all output coordinates lie within `[-360, 360]`.
/// Consecutive points within each segment differ by ≤ 180°, so
/// [`densify_by_distance`] follows the correct short great-circle path without
/// crossing the antimeridian.
///
/// Returns segments ordered oldest-first. Segments with fewer than 2 points are
/// dropped (a crossing at the very first pair leaves a single pre-crossing point
/// that cannot form a valid line).
fn split_at_antimeridian(pts: &[(f64, f64)]) -> Vec<Vec<(f64, f64)>> {
    if pts.is_empty() {
        return Vec::new();
    }
    let mut segs: Vec<Vec<(f64, f64)>> = Vec::new();
    let mut seg: Vec<(f64, f64)> = vec![pts[0]];
    let (mut prev_lon, mut prev_lat) = pts[0];
    for &(lon, lat) in &pts[1..] {
        if (lon - prev_lon).abs() > 180.0 {
            segs.push(std::mem::take(&mut seg));
            let handover_lon = prev_lon + if lon < prev_lon { -360.0 } else { 360.0 };
            seg = vec![(handover_lon, prev_lat)];
        }
        seg.push((lon, lat));
        prev_lon = lon;
        prev_lat = lat;
    }
    segs.push(seg);
    segs.into_iter().filter(|s| s.len() >= 2).collect()
}

/// GC-densify a segment whose consecutive pairs have `|Δlon| ≤ 180°`.
fn densify_track_segment(pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
    if pts.len() < 2 {
        return pts.to_vec();
    }
    let mut out = Vec::with_capacity(pts.len() * 2);
    out.push(pts[0]);
    let (mut prev_lon, mut prev_lat) = pts[0];
    for &(lon, lat) in &pts[1..] {
        out.extend(densify_by_distance(prev_lon, prev_lat, lon, lat));
        prev_lon = lon;
        prev_lat = lat;
    }
    out
}

/// `(coords, overflow_segments, fade_stop)` returned by [`process_track_core`].
type TrackSegments = (Vec<(f64, f64)>, Vec<Vec<(f64, f64)>>, f64);

/// Split raw track at antimeridian crossings, GC-densify each segment, and compute
/// the line-gradient fade-stop fraction.
///
/// Returns `(coords, overflow_segments, fade_stop)`:
/// `coords` — most recent segment, carries the line-gradient.
/// `overflow_segments` — older segments, rendered as solid lines.
/// `fade_stop` — fade distance = `min(0.5 nm, 10% of coords' length)`,
/// expressed as a fraction of `coords`' total length (`0` when zero-length).
fn process_track_core(raw: &[(f64, f64)]) -> TrackSegments {
    if raw.len() < 2 {
        return (raw.to_vec(), Vec::new(), 0.0);
    }
    let mut segs: Vec<Vec<(f64, f64)>> = split_at_antimeridian(raw)
        .into_iter()
        .map(|s| densify_track_segment(&s))
        .collect();
    let coords = segs.pop().unwrap_or_else(|| raw.to_vec());
    let overflow_segments = segs;
    let mut total = 0.0;
    for w in coords.windows(2) {
        total += haversine_meters(w[0].0, w[0].1, w[1].0, w[1].1);
    }
    let fade_stop = if total > 0.0 {
        ((0.5 * 1852.0_f64).min(total * 0.1) / total).min(1.0)
    } else {
        0.0
    };
    (coords, overflow_segments, fade_stop)
}

/// Split raw route or two-point line at antimeridian crossings and GC-densify each
/// segment. Returns one densified segment per antimeridian-bounded piece, all
/// within `[-360, 360]`.
fn process_route_coords_core(raw: &[(f64, f64)]) -> Vec<Vec<(f64, f64)>> {
    if raw.len() < 2 {
        return Vec::new();
    }
    split_at_antimeridian(raw)
        .into_iter()
        .map(|s| densify_track_segment(&s))
        .collect()
}

/// Unpack a flat `[lon0, lat0, lon1, lat1, …]` array (as passed from a JS
/// `Float64Array`) into coordinate pairs.
fn pairs_from_flat(flat: &[f64]) -> Vec<(f64, f64)> {
    flat.as_chunks::<2>()
        .0
        .iter()
        .map(|&[a, b]| (a, b))
        .collect()
}

/// Result of [`process_track_core`], camelCase for JS.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessTrackResult {
    coords: Vec<(f64, f64)>,
    overflow_segments: Vec<Vec<(f64, f64)>>,
    fade_stop: f64,
}

/// Split raw track (flat `[lon0, lat0, lon1, lat1, …]`) at antimeridian crossings,
/// GC-densify each segment, and compute the line-gradient fade-stop fraction. One
/// batched call per track update — see [`process_track_core`].
#[wasm_bindgen(js_name = processTrack)]
pub fn process_track(flat: &[f64]) -> Result<JsValue, JsValue> {
    let raw = pairs_from_flat(flat);
    let (coords, overflow_segments, fade_stop) = process_track_core(&raw);
    let result = ProcessTrackResult {
        coords,
        overflow_segments,
        fade_stop,
    };
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Split raw route/line coords (flat `[lon0, lat0, lon1, lat1, …]`) at antimeridian
/// crossings and GC-densify each segment. One batched call per route update — see
/// [`process_route_coords_core`].
#[wasm_bindgen(js_name = processRouteCoords)]
pub fn process_route_coords(flat: &[f64]) -> Result<JsValue, JsValue> {
    let raw = pairs_from_flat(flat);
    let segs = process_route_coords_core(&raw);
    serde_wasm_bindgen::to_value(&segs).map_err(|e| JsValue::from_str(&e.to_string()))
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
/// Dateline-aware containment test for chart bounds `[west, south, east, north]`.
///
/// The longitude extent is the arc from `west` eastward to `east`:
/// `west <= east` reads as the plain interval, `west > east` as an arc
/// crossing the antimeridian (chart-catalog convention — `[170, -170]` is the
/// 20° strip across the Pacific, which a naive interval test can never
/// satisfy). `east - west >= 360` covers the whole circle.
pub fn bounds_contain(w: f64, s: f64, e: f64, n: f64, lon: f64, lat: f64) -> bool {
    if lat < s || lat > n {
        return false;
    }
    if e - w >= 360.0 {
        return true;
    }
    (lon - w).rem_euclid(360.0) <= (e - w).rem_euclid(360.0)
}

/// Center of chart bounds `[west, south, east, north]` — see [`bounds_contain`]
/// for the longitude convention. Returns `[center_lon, center_lat]` with
/// `center_lon` canonical (normalized to `[-180, 180)`, matching
/// [`union_bounds`]): the center of the Pacific strip `[170, -170]` is `-180`,
/// not the naive `(w + e) / 2 = 0` in the Gulf of Guinea.
pub fn bounds_center(w: f64, s: f64, e: f64, n: f64) -> [f64; 2] {
    let span = if e - w >= 360.0 {
        360.0
    } else {
        (e - w).rem_euclid(360.0)
    };
    [wrap180(w + span / 2.0), (s + n) / 2.0]
}

/// Dateline-aware chart-bounds containment — see [`bounds_contain`].
#[wasm_bindgen(js_name = chartBoundsContain)]
pub fn chart_bounds_contain(w: f64, s: f64, e: f64, n: f64, lon: f64, lat: f64) -> bool {
    bounds_contain(w, s, e, n, lon, lat)
}

/// Center of chart bounds — see [`bounds_center`]. Returns `[lon, lat]`.
#[wasm_bindgen(js_name = chartBoundsCenter)]
pub fn chart_bounds_center(w: f64, s: f64, e: f64, n: f64) -> Vec<f64> {
    bounds_center(w, s, e, n).to_vec()
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
    fn line_near_antipodal_produces_finite_coords() {
        // Near-antipodal: (0,0) → (179.9999999, 0.00001) — haversine h rounds
        // fractionally above 1.0, which formerly made asin return NaN.
        let coords = line_coords(0.0, 0.0, 179.9999999, 0.00001, 16);
        assert!(coords.len() >= 2, "should produce at least start and end");
        for (i, &(lon, lat)) in coords.iter().enumerate() {
            assert!(lon.is_finite(), "NaN/Inf longitude at index {i}");
            assert!(lat.is_finite(), "NaN/Inf latitude at index {i}");
        }
    }

    #[test]
    fn line_exactly_antipodal_produces_finite_coords() {
        // Exactly antipodal: (0, 0) → (180, 0).
        // The angular distance is π; SLERP is degenerate (infinite great
        // circles) but the interpolation must still return finite values.
        let coords = line_coords(0.0, 0.0, 180.0, 0.0, 16);
        assert!(coords.len() >= 2, "should produce at least start and end");
        for (i, &(lon, lat)) in coords.iter().enumerate() {
            assert!(lon.is_finite(), "NaN/Inf longitude at index {i}");
            assert!(lat.is_finite(), "NaN/Inf latitude at index {i}");
        }
        // Endpoints should approximately match inputs.
        let (first_lon, first_lat) = coords[0];
        let (last_lon, last_lat) = *coords.last().unwrap();
        assert!((first_lon - 0.0).abs() < 1e-6, "start lon");
        assert!((first_lat - 0.0).abs() < 1e-6, "start lat");
        assert!((last_lon - 180.0).abs() < 1e-3, "end lon");
        assert!((last_lat - 0.0).abs() < 1e-3, "end lat");
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
    #[test]
    fn bounds_contain_plain_interval() {
        assert!(bounds_contain(5.0, 50.0, 15.0, 60.0, 10.0, 55.0));
        assert!(!bounds_contain(5.0, 50.0, 15.0, 60.0, 20.0, 55.0)); // lon outside
        assert!(!bounds_contain(5.0, 50.0, 15.0, 60.0, 10.0, 65.0)); // lat outside
                                                                     // Edges are inclusive.
        assert!(bounds_contain(5.0, 50.0, 15.0, 60.0, 5.0, 50.0));
        assert!(bounds_contain(5.0, 50.0, 15.0, 60.0, 15.0, 60.0));
    }

    #[test]
    fn bounds_contain_across_dateline() {
        // [170, -170]: the 20° Pacific strip — a naive interval test is never true.
        assert!(bounds_contain(170.0, -10.0, -170.0, 10.0, 175.0, 0.0));
        assert!(bounds_contain(170.0, -10.0, -170.0, 10.0, -175.0, 0.0));
        assert!(bounds_contain(170.0, -10.0, -170.0, 10.0, 180.0, 0.0));
        assert!(!bounds_contain(170.0, -10.0, -170.0, 10.0, 0.0, 0.0));
        assert!(!bounds_contain(170.0, -10.0, -170.0, 10.0, 165.0, 0.0));
    }

    #[test]
    fn bounds_contain_full_world() {
        assert!(bounds_contain(-180.0, -90.0, 180.0, 90.0, 123.0, 45.0));
        assert!(bounds_contain(-180.0, -90.0, 180.0, 90.0, -180.0, 0.0));
    }

    #[test]
    fn bounds_center_plain() {
        assert_eq!(bounds_center(5.0, 50.0, 15.0, 60.0), [10.0, 55.0]);
    }

    #[test]
    fn bounds_center_across_dateline() {
        // Pacific strip centers on the antimeridian (canonical -180),
        // not (170 + -170) / 2 = 0 in the Gulf of Guinea.
        assert_eq!(bounds_center(170.0, -10.0, -170.0, 10.0), [-180.0, 0.0]);
    }

    #[test]
    fn bounds_center_full_world() {
        let c = bounds_center(-180.0, -90.0, 180.0, 90.0);
        assert_eq!(c[1], 0.0);
        assert!((-180.0..180.0).contains(&c[0]));
    }

    // ---- split_at_antimeridian (ported from trackProcessing.test.ts) ----

    #[test]
    fn split_at_antimeridian_empty_input() {
        assert_eq!(split_at_antimeridian(&[]), Vec::<Vec<(f64, f64)>>::new());
    }

    #[test]
    fn split_at_antimeridian_no_crossings_returns_one_segment() {
        let pts = vec![(-170.0, 10.0), (0.0, 10.0), (170.0, 10.0)];
        assert_eq!(split_at_antimeridian(&pts), vec![pts]);
    }

    #[test]
    fn split_at_antimeridian_two_point_eastward_crossing() {
        // 170°E → -170°W: crosses the antimeridian. The pre-crossing side has only
        // one point, so it is dropped (not a valid line). The output is a single
        // segment starting at the handover point.
        let pts = vec![(170.0, 10.0), (-170.0, 10.0)];
        let segs = split_at_antimeridian(&pts);
        assert_eq!(segs.len(), 1);
        // Handover: 170 - 360 = -190, followed by the raw post-crossing point.
        assert_eq!(segs[0][0].0, -190.0);
        assert_eq!(segs[0][1].0, -170.0);
    }

    #[test]
    fn split_at_antimeridian_two_point_westward_crossing() {
        // -170°W → 170°E: crosses the antimeridian.
        let pts = vec![(-170.0, 10.0), (170.0, 10.0)];
        let segs = split_at_antimeridian(&pts);
        assert_eq!(segs.len(), 1);
        // Handover: -170 + 360 = 190, followed by the raw post-crossing point.
        assert_eq!(segs[0][0].0, 190.0);
        assert_eq!(segs[0][1].0, 170.0);
    }

    #[test]
    fn split_at_antimeridian_all_output_within_360() {
        // 8 antimeridian crossings (westward 3°/step, 500 points).
        let raw: Vec<(f64, f64)> = (0..500)
            .map(|i| (wrap180(-3.0 * f64::from(i)), 10.0))
            .collect();
        for seg in split_at_antimeridian(&raw) {
            for (lon, _) in seg {
                assert!((-360.0..=360.0).contains(&lon), "lon {lon} out of range");
            }
        }
    }

    #[test]
    fn split_at_antimeridian_multi_circumnavigation_multiple_segments() {
        let raw: Vec<(f64, f64)> = (0..500)
            .map(|i| (wrap180(-3.0 * f64::from(i)), 10.0))
            .collect();
        assert!(split_at_antimeridian(&raw).len() > 4);
    }

    #[test]
    fn split_at_antimeridian_step_within_new_segment_is_short_path() {
        // Eastward crossing with 3+ points so both segments are valid.
        let pts = vec![(160.0, 10.0), (170.0, 10.0), (-170.0, 10.0), (-160.0, 10.0)];
        let segs = split_at_antimeridian(&pts);
        assert_eq!(segs.len(), 2);
        let seg2 = &segs[1];
        // Step from handover (170 - 360 = -190) to first raw point (-170).
        assert!((seg2[1].0 - seg2[0].0).abs() <= 180.0);
    }

    // ---- densify_by_distance / haversine_meters (direct) ----

    #[test]
    fn haversine_meters_one_degree_latitude() {
        // 1° of latitude along a meridian ≈ 111.195 km (matches R_M = 6,371,000 m).
        let d = haversine_meters(0.0, 0.0, 0.0, 1.0);
        assert!((d - 111_195.0).abs() < 50.0, "expected ~111,195 m, got {d}");
    }

    #[test]
    fn densify_by_distance_short_segment_is_endpoint_only() {
        // Under ~50 km: no intermediate points, just the endpoint.
        let pts = densify_by_distance(0.0, 0.0, 0.1, 0.0); // ~11 km
        assert_eq!(pts, vec![(0.1, 0.0)]);
    }

    #[test]
    fn densify_by_distance_long_segment_spacing_is_about_50km() {
        // 10° of longitude at the equator ≈ 1,113 km — expect ~23 points spaced ~50 km apart.
        let pts = densify_by_distance(0.0, 0.0, 10.0, 0.0);
        assert!(
            pts.len() > 15,
            "expected many intermediate points, got {}",
            pts.len()
        );
        let mut prev = (0.0, 0.0);
        for &p in &pts {
            let d = haversine_meters(prev.0, prev.1, p.0, p.1);
            assert!(d < 60_000.0, "spacing {d} m exceeds ~50 km target");
            prev = p;
        }
    }

    #[test]
    fn densify_by_distance_ends_at_exact_endpoint() {
        let pts = densify_by_distance(0.0, 0.0, 10.0, 5.0);
        assert_eq!(*pts.last().unwrap(), (10.0, 5.0));
    }

    #[test]
    fn densify_by_distance_preserves_longitude_continuity_from_shifted_start() {
        // Start from a handover longitude past ±180° (as split_at_antimeridian
        // produces) — intermediate points must stay unwrapped, not jump back
        // into [-180, 180].
        let pts = densify_by_distance(-190.0, 10.0, -170.0, 10.0);
        for &(lon, _) in &pts {
            assert!(
                (-200.0..=-160.0).contains(&lon),
                "lon {lon} jumped out of the expected unwrapped range"
            );
        }
    }

    #[test]
    fn densify_by_distance_antipodal_points_do_not_produce_nan() {
        // Antipodal endpoints: the great circle between them is undefined
        // (sin_d ≈ 0); must fall back to the endpoint, never emit NaN/Inf.
        let pts = densify_by_distance(0.0, 0.0, 180.0, 0.0);
        assert_eq!(pts, vec![(180.0, 0.0)]);
    }

    #[test]
    fn densify_by_distance_antipodal_guard_fires_at_nonzero_latitude() {
        // At certain nonzero latitudes, sin²(phi) + cos²(phi) rounds to
        // 1 ULP below 1.0 in f64, so the exactly-antipodal cos_d formula
        // lands 1 ULP above -1.0 instead of clamping — sin_d ≈ 1.49e-8.
        // The former 1e-12 guard missed this (1.49e-8 >> 1e-12), letting
        // the SLERP collapse the 20 000 km leg into two clustered dots
        // with a midpoint jump.  The raised 1e-6 guard catches it
        // (1.49e-8 < 1e-6) and falls back to the endpoint.
        //
        // lat = ±0.002° is the smallest value that reliably exhibits the
        // 1-ULP rounding on x86-64 with the standard libm.
        let pts = densify_by_distance(0.0, 0.002, 180.0, -0.002);
        // Must fall back to the endpoint, same as the equatorial case.
        assert_eq!(
            pts,
            vec![(180.0, -0.002)],
            "antipodal guard must fire at nonzero latitude; got {} points instead of fallback",
            pts.len()
        );
    }

    // ---- process_track_core ----

    #[test]
    fn process_track_empty_and_single_point_no_overflow() {
        let (coords, overflow, _) = process_track_core(&[]);
        assert!(coords.is_empty());
        assert!(overflow.is_empty());
        let (coords, overflow, _) = process_track_core(&[(0.0, 10.0)]);
        assert_eq!(coords, vec![(0.0, 10.0)]);
        assert!(overflow.is_empty());
    }

    #[test]
    fn process_track_no_overflow_for_simple_non_crossing_track() {
        let raw = vec![(0.0, 10.0), (10.0, 10.0), (20.0, 10.0)];
        let (_, overflow, _) = process_track_core(&raw);
        assert!(overflow.is_empty());
    }

    #[test]
    fn process_track_splits_into_overflow_and_coords_on_single_crossing() {
        let raw = vec![(170.0, 10.0), (175.0, 10.0), (-175.0, 10.0), (-170.0, 10.0)];
        let (coords, overflow, _) = process_track_core(&raw);
        assert_eq!(overflow.len(), 1);
        for seg in std::iter::once(&coords).chain(overflow.iter()) {
            for &(lon, _) in seg {
                assert!((-360.0..=360.0).contains(&lon), "lon {lon} out of range");
            }
        }
    }

    #[test]
    fn process_track_within_360_westward_multi_circumnavigation() {
        let raw: Vec<(f64, f64)> = (0..500)
            .map(|i| (wrap180(-3.0 * f64::from(i)), 10.0))
            .collect();
        let (coords, overflow, _) = process_track_core(&raw);
        for seg in std::iter::once(&coords).chain(overflow.iter()) {
            for &(lon, _) in seg {
                assert!((-360.0..=360.0).contains(&lon), "lon {lon} out of range");
            }
        }
        assert!(overflow.len() > 1);
    }

    #[test]
    fn process_track_within_360_eastward_multi_circumnavigation() {
        let raw: Vec<(f64, f64)> = (0..500)
            .map(|i| (wrap180(3.0 * f64::from(i)), 10.0))
            .collect();
        let (coords, overflow, _) = process_track_core(&raw);
        for seg in std::iter::once(&coords).chain(overflow.iter()) {
            for &(lon, _) in seg {
                assert!((-360.0..=360.0).contains(&lon), "lon {lon} out of range");
            }
        }
        assert!(overflow.len() > 1);
    }

    #[test]
    fn process_track_coords_is_the_last_segment() {
        // Track going eastward past the antimeridian: last raw point at -170°.
        // coords should contain that final point, unchanged by densification.
        let raw = vec![(170.0, 10.0), (175.0, 10.0), (-175.0, 10.0), (-170.0, 10.0)];
        let (coords, _, _) = process_track_core(&raw);
        let (lon, lat) = *coords.last().unwrap();
        assert!((lon - -170.0).abs() < 1e-5);
        assert!((lat - 10.0).abs() < 1e-5);
    }

    #[test]
    fn process_track_fade_stop_uses_ten_percent_for_short_tracks() {
        // Two ~1113 m segments (0.01° lon at the equator ≈ 1113 m): total stays
        // under the 0.5 nm (926 m) cap threshold (total*0.1 < 926 m needs
        // total < 9260 m), so the 10%-of-length branch applies.
        let raw = vec![(0.0, 0.0), (0.01, 0.0), (0.02, 0.0)];
        let (coords, _, fade_stop) = process_track_core(&raw);
        let total: f64 = coords
            .windows(2)
            .map(|w| haversine_meters(w[0].0, w[0].1, w[1].0, w[1].1))
            .sum();
        assert!(
            total < 9260.0,
            "fixture must stay under the cap threshold, got {total}"
        );
        assert!(
            (fade_stop - 0.1).abs() < 1e-9,
            "expected exactly 10%, got {fade_stop}"
        );
    }

    #[test]
    fn process_track_fade_stop_caps_at_half_nm_for_long_tracks() {
        // 10° longitude segments at lat 10° are ~1096 km each — total length is
        // orders of magnitude past the 0.5 nm cap threshold.
        let raw = vec![(0.0, 10.0), (10.0, 10.0), (20.0, 10.0)];
        let (coords, _, fade_stop) = process_track_core(&raw);
        let total: f64 = coords
            .windows(2)
            .map(|w| haversine_meters(w[0].0, w[0].1, w[1].0, w[1].1))
            .sum();
        assert!(
            total > 9260.0,
            "fixture must exceed the cap threshold, got {total}"
        );
        let expected = (0.5 * 1852.0) / total;
        assert!(
            (fade_stop - expected).abs() < 1e-9,
            "expected {expected}, got {fade_stop}"
        );
    }

    // ---- process_route_coords_core ----

    #[test]
    fn process_route_coords_empty_and_single_point() {
        assert!(process_route_coords_core(&[]).is_empty());
        assert!(process_route_coords_core(&[(0.0, 10.0)]).is_empty());
    }

    #[test]
    fn process_route_coords_one_segment_no_crossing() {
        let raw = vec![(-100.0, 10.0), (0.0, 10.0), (100.0, 10.0)];
        assert_eq!(process_route_coords_core(&raw).len(), 1);
    }

    #[test]
    fn process_route_coords_one_valid_segment_two_point_crossing() {
        // Pre-crossing side has 1 point → filtered out.
        let raw = vec![(170.0, 10.0), (-170.0, 10.0)];
        let segs = process_route_coords_core(&raw);
        assert_eq!(segs.len(), 1);
        for seg in &segs {
            assert!(seg.len() >= 2);
            for &(lon, _) in seg {
                assert!((-360.0..=360.0).contains(&lon), "lon {lon} out of range");
            }
        }
    }

    #[test]
    fn process_route_coords_two_segments_multi_point_crossing() {
        let raw = vec![(160.0, 10.0), (170.0, 10.0), (-170.0, 10.0), (-160.0, 10.0)];
        let segs = process_route_coords_core(&raw);
        assert_eq!(segs.len(), 2);
        for seg in &segs {
            assert!(seg.len() >= 2);
            for &(lon, _) in seg {
                assert!((-360.0..=360.0).contains(&lon), "lon {lon} out of range");
            }
        }
    }
}
