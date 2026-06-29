//! Dual-run parity: every fixture under `fixtures/` (see `fixtures/README.md`
//! for provenance) is fed through the old `signalk`-crate-backed path
//! (`signalk_chart_core::signalk`) and the new purpose-built path
//! (`signalk_chart_core::skdata`) and the extracted, chart-relevant outputs
//! are asserted equal — proof of behavioural equivalence (modulo the one
//! confirmed, intentional bug fix) before the old crate dependency is
//! dropped. See `KNOWLEDGE_BASE.md` ADR-009.
//!
//! `accuracy_sibling_delta.json` is the one fixture where outputs *must*
//! diverge — that divergence is the bug the rewrite fixes, asserted
//! explicitly in `accuracy_sibling_bug_is_fixed_not_just_moved`.

use signalk_chart_core::{signalk as old, skdata as new};

/// Feed every element of a JSON array of delta messages (or a single message)
/// through the old (`signalk`-crate-backed) `apply_message`, in order.
fn replay_old(storage: &mut signalk::Storage, fixture: &str) {
    let v: serde_json::Value = serde_json::from_str(fixture).unwrap();
    let messages: Vec<String> = match v {
        serde_json::Value::Array(items) => items.into_iter().map(|i| i.to_string()).collect(),
        single => vec![single.to_string()],
    };
    for msg in messages {
        old::apply_message(storage, &msg).expect("old path should accept fixture JSON");
    }
}

/// Feed every element of a JSON array of delta messages (or a single message)
/// through the new (`skdata`) `apply_message`, in order.
fn replay_new(storage: &mut new::Storage, fixture: &str) {
    let v: serde_json::Value = serde_json::from_str(fixture).unwrap();
    let messages: Vec<String> = match v {
        serde_json::Value::Array(items) => items.into_iter().map(|i| i.to_string()).collect(),
        single => vec![single.to_string()],
    };
    for msg in messages {
        new::apply_message(storage, &msg).expect("new path should accept fixture JSON");
    }
}

/// Compares the (private, no-accessor) `course` field of each `VesselState`
/// via its serde JSON representation rather than direct field access.
fn course_json(state: &impl serde::Serialize) -> serde_json::Value {
    serde_json::to_value(state)
        .unwrap()
        .get("course")
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

fn opt_f64_eq(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => (a - b).abs() < 1e-9,
        _ => false,
    }
}

/// Runs `fixture` through both implementations from a fresh, self-aware
/// `Storage`, returning the extracted self-vessel `VesselState` from each.
fn dual_run_self(self_context: &str, fixture: &str) -> (old::VesselState, new::VesselState) {
    let mut os = signalk::Storage::new(signalk::V1FullFormat::default());
    os.set_self(self_context);
    replay_old(&mut os, fixture);

    let mut ns = new::Storage::default();
    ns.set_self(self_context);
    replay_new(&mut ns, fixture);

    (old::extract_vessel_state(&os), new::extract_vessel_state(&ns))
}

const SELF_CTX: &str = "vessels.urn:mrn:signalk:uuid:168eec6c-6d2f-4ce4-b5fe-911711ebbcf0";

#[test]
fn self_nav_sequence_matches() {
    let fixture = include_str!("fixtures/self_nav_sequence.json");
    let (old_state, new_state) = dual_run_self(SELF_CTX, fixture);
    assert!(
        opt_f64_eq(old_state.sog, new_state.sog),
        "sog: old={:?} new={:?}",
        old_state.sog,
        new_state.sog
    );
    assert!(
        opt_f64_eq(old_state.cog, new_state.cog),
        "cog: old={:?} new={:?}",
        old_state.cog,
        new_state.cog
    );
    assert!(
        opt_f64_eq(old_state.heading, new_state.heading),
        "heading: old={:?} new={:?}",
        old_state.heading,
        new_state.heading
    );
    match (old_state.position, new_state.position) {
        (Some(a), Some(b)) => {
            assert!((a.longitude - b.longitude).abs() < 1e-9);
            assert!((a.latitude - b.latitude).abs() < 1e-9);
        }
        (a, b) => panic!("position: old={a:?} new={b:?}"),
    }
}

#[test]
fn course_destination_delta_matches() {
    let fixture = include_str!("fixtures/course_destination_delta.json");
    let (old_state, new_state) = dual_run_self(SELF_CTX, fixture);
    let (old_course, new_course) = (course_json(&old_state), course_json(&new_state));
    assert_eq!(
        old_course, new_course,
        "course mismatch: old={old_course:?} new={new_course:?}"
    );
}

#[test]
fn accuracy_sibling_bug_is_fixed_not_just_moved() {
    // Reproduces the confirmed upstream dispatch bug (see
    // `crates/core/src/signalk.rs`'s `strip_accuracy_siblings` doc comment and
    // `crates/core/src/skdata.rs`'s module doc comment). The old path only
    // gets this right *because* of its `strip_accuracy_siblings` workaround;
    // the new path gets it right with no workaround at all — exact full-path
    // dispatch structurally cannot match a `.accuracy` suffix. This asserts
    // both still agree (parity holds with the old path's patch in place) and
    // that the value is the correct one, not the corrupted one.
    let fixture = include_str!("fixtures/accuracy_sibling_delta.json");
    let self_ctx = "vessels.urn:mrn:signalk:uuid:self";
    let (old_state, new_state) = dual_run_self(self_ctx, fixture);
    assert!(
        opt_f64_eq(old_state.cog, new_state.cog),
        "cog: old={:?} new={:?}",
        old_state.cog,
        new_state.cog
    );
    assert_eq!(new_state.cog, Some(3.639211760122151));
}

#[test]
fn ais_bundled_update_matches() {
    let fixture = include_str!("fixtures/ais_bundled_update.json");

    let mut os = signalk::Storage::new(signalk::V1FullFormat::default());
    os.set_self(SELF_CTX);
    replay_old(&mut os, fixture);
    let old_targets = old::extract_ais_targets(&os, f64::INFINITY, f64::INFINITY);

    let mut ns = new::Storage::default();
    ns.set_self(SELF_CTX);
    replay_new(&mut ns, fixture);
    let new_targets = new::extract_ais_targets(&ns, f64::INFINITY, f64::INFINITY);

    // This fixture has no `navigation.datetime`, so both paths must drop it entirely.
    assert!(old_targets.is_empty(), "old path: {old_targets:?}");
    assert!(new_targets.is_empty(), "new path: {new_targets:?}");
}

#[test]
fn ais_with_datetime_matches() {
    let fixture = include_str!("fixtures/ais_with_datetime.json");

    let mut os = signalk::Storage::new(signalk::V1FullFormat::default());
    os.set_self(SELF_CTX);
    replay_old(&mut os, fixture);
    let old_targets = old::extract_ais_targets(&os, f64::INFINITY, f64::INFINITY);

    let mut ns = new::Storage::default();
    ns.set_self(SELF_CTX);
    replay_new(&mut ns, fixture);
    let new_targets = new::extract_ais_targets(&ns, f64::INFINITY, f64::INFINITY);

    assert_eq!(old_targets.len(), 1);
    assert_eq!(new_targets.len(), 1);
    assert_eq!(old_targets[0].id, new_targets[0].id);
    assert_eq!(old_targets[0].mmsi, new_targets[0].mmsi);
    assert_eq!(
        old_targets[0].last_position_update_ms,
        new_targets[0].last_position_update_ms
    );
    let (op, np) = (old_targets[0].position.unwrap(), new_targets[0].position.unwrap());
    assert!((op.longitude - np.longitude).abs() < 1e-9);
    assert!((op.latitude - np.latitude).abs() < 1e-9);
}

#[test]
fn hello_sets_self_identically() {
    let fixture = include_str!("fixtures/hello.json");

    let mut os = signalk::Storage::new(signalk::V1FullFormat::default());
    old::apply_message(&mut os, fixture).unwrap();

    let mut ns = new::Storage::default();
    new::apply_message(&mut ns, fixture).unwrap();

    // Feed the self-nav sequence after Hello (no explicit set_self call) to confirm
    // both paths inferred the same self id from the Hello message alone.
    replay_old(&mut os, include_str!("fixtures/self_nav_sequence.json"));
    replay_new(&mut ns, include_str!("fixtures/self_nav_sequence.json"));

    let old_state = old::extract_vessel_state(&os);
    let new_state = new::extract_vessel_state(&ns);
    assert!(opt_f64_eq(old_state.sog, new_state.sog));
}
