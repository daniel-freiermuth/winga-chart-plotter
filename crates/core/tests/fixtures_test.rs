//! Regression tests against the real/spec-verified wire-delta fixtures in
//! `fixtures/` (see `fixtures/README.md` for provenance). These fixtures were
//! originally captured to dual-run parity-test `skdata` against the
//! `signalk`-crate-backed implementation it replaced (ADR-009); now that the
//! cutover is complete, they continue to pin `skdata`'s behaviour against
//! real wire bytes rather than just hand-written literals.

use signalk_chart_core::skdata::{
    apply_message, extract_ais_targets, extract_vessel_state, Storage,
};

const SELF_CTX: &str = "vessels.urn:mrn:signalk:uuid:168eec6c-6d2f-4ce4-b5fe-911711ebbcf0";

/// Feed every element of a JSON array of delta messages (or a single message)
/// through `apply_message`, in order.
fn replay(storage: &mut Storage, fixture: &str) {
    let v: serde_json::Value = serde_json::from_str(fixture).unwrap();
    let messages: Vec<String> = match v {
        serde_json::Value::Array(items) => items.into_iter().map(|i| i.to_string()).collect(),
        single => vec![single.to_string()],
    };
    for msg in messages {
        apply_message(storage, &msg).expect("fixture JSON should be accepted");
    }
}

#[test]
fn accuracy_sibling_does_not_clobber_cog() {
    // Real delta captured on a live boat (`ws.Disen.signalk-nav-provider`) during the
    // original COG-flicker bug investigation: the `.accuracy` sibling arrives *after*
    // the real value in the same `values` array — exactly the ordering that broke the
    // upstream `signalk` crate's recursive-segment dispatch.
    let mut storage = Storage::default();
    storage.set_self("vessels.urn:mrn:signalk:uuid:self");
    replay(
        &mut storage,
        include_str!("fixtures/accuracy_sibling_delta.json"),
    );
    let state = extract_vessel_state(&storage);
    assert_eq!(state.cog, Some(3.639211760122151));
}

#[test]
fn self_nav_sequence_sets_expected_fields() {
    let mut storage = Storage::default();
    storage.set_self(SELF_CTX);
    replay(
        &mut storage,
        include_str!("fixtures/self_nav_sequence.json"),
    );
    let state = extract_vessel_state(&storage);
    assert_eq!(state.sog, Some(3.28));
    assert_eq!(state.cog, Some(3.5308));
    assert_eq!(state.heading, Some(3.5622));
    let pos = state.position.expect("position should be set");
    assert!((pos.longitude - 24.7307394).abs() < 1e-9);
    assert!((pos.latitude - 59.7150513).abs() < 1e-9);
}

#[test]
fn course_destination_delta_sets_expected_course() {
    let mut storage = Storage::default();
    storage.set_self(SELF_CTX);
    replay(
        &mut storage,
        include_str!("fixtures/course_destination_delta.json"),
    );
    let state = extract_vessel_state(&storage);
    let json = serde_json::to_value(&state).unwrap();
    let course = json.get("course").expect("course should be present");

    let next = &course["nextPoint"];
    assert!((next["longitude"].as_f64().unwrap() - 24.80).abs() < 1e-9);
    assert!((next["latitude"].as_f64().unwrap() - 59.92).abs() < 1e-9);

    let prev = &course["previousPoint"];
    assert!((prev["longitude"].as_f64().unwrap() - 24.7307394).abs() < 1e-9);
    assert!((prev["latitude"].as_f64().unwrap() - 59.7150513).abs() < 1e-9);

    let route = &course["activeRoute"];
    assert_eq!(
        route["href"],
        "/signalk/v1/api/resources/routes/3b1f1f0a-6e1e-4f0e-9b7a-1f1c8e9a2b3c"
    );
    assert_eq!(route["name"], "Helsinki to Tallinn");
    assert_eq!(route["pointIndex"], 2);
    assert_eq!(route["reverse"], false);
}

#[test]
fn ais_bundled_update_without_datetime_is_dropped_but_fields_are_captured() {
    // Real shape bundling modeled navigation fields alongside ones we don't model
    // (navigation.state, sensors.ais.class) and a `"path": ""` merge entry — none of
    // that should corrupt the modeled fields or crash. No `navigation.datetime` is
    // present, so the vessel must not appear as an AIS target yet (we have no way to
    // tell it isn't stale) — supplying datetime afterward should then reveal it with
    // the values captured from the bundled update intact.
    let mut storage = Storage::default();
    storage.set_self(SELF_CTX);
    replay(
        &mut storage,
        include_str!("fixtures/ais_bundled_update.json"),
    );
    assert!(extract_ais_targets(&storage, f64::INFINITY, f64::INFINITY).is_empty());

    apply_message(
        &mut storage,
        r#"{"context": "vessels.urn:mrn:imo:mmsi:248071000", "updates": [{"values": [
            {"path": "navigation.datetime", "value": "2014-08-15T19:05:37.063Z"}
        ]}]}"#,
    )
    .unwrap();
    let targets = extract_ais_targets(&storage, f64::INFINITY, f64::INFINITY);
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].mmsi, Some("248071000".to_string()));
    assert_eq!(targets[0].sog, Some(7.2));
    assert_eq!(targets[0].cog, Some(4.4541));
    let pos = targets[0].position.unwrap();
    assert!((pos.longitude - 24.8868133).abs() < 1e-9);
}

#[test]
fn ais_with_datetime_appears_as_single_target() {
    let mut storage = Storage::default();
    storage.set_self(SELF_CTX);
    replay(
        &mut storage,
        include_str!("fixtures/ais_with_datetime.json"),
    );
    let targets = extract_ais_targets(&storage, f64::INFINITY, f64::INFINITY);
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].id, "urn:mrn:imo:mmsi:248071000");
    assert_eq!(targets[0].mmsi, Some("248071000".to_string()));
    let pos = targets[0].position.unwrap();
    assert!((pos.longitude - 24.8901).abs() < 1e-9);
    assert!((pos.latitude - 59.8320).abs() < 1e-9);
}

#[test]
fn hello_then_nav_sequence_sets_self_correctly() {
    let mut storage = Storage::default();
    replay(&mut storage, include_str!("fixtures/hello.json"));
    replay(
        &mut storage,
        include_str!("fixtures/self_nav_sequence.json"),
    );
    let state = extract_vessel_state(&storage);
    assert_eq!(state.sog, Some(3.28));
}
