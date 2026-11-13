//! Shared parsing for Signal K v2 resource collections
//! (`GET /signalk/v2/api/resources/<kind>` → `{ "<uuid>": <resource>, … }`).
//!
//! The collection is written by any number of clients and plugins, so one
//! foreign or malformed resource must not hide the rest: each entry is
//! decoded independently and entries that do not fit the typed shape are
//! skipped. Only a body that is not a JSON object fails as a whole.

use serde::de::DeserializeOwned;
use std::collections::HashMap;

/// Decode a resource collection, keeping every entry that matches `T` and
/// dropping the ones that do not. Returns `Err` only when `text` is not a
/// JSON object.
pub(crate) fn parse_resource_record<T: DeserializeOwned>(
    text: &str,
    context: &'static str,
) -> crate::Result<HashMap<String, T>> {
    let raw: HashMap<String, serde_json::Value> =
        serde_json::from_str(text).map_err(crate::Error::json(context))?;
    Ok(raw
        .into_iter()
        .filter_map(|(id, value)| serde_json::from_value(value).ok().map(|entry| (id, entry)))
        .collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn non_object_body_is_an_error() {
        let err = parse_resource_record::<serde_json::Value>("[1,2]", "Routes API").unwrap_err();
        assert!(err.to_string().starts_with("Routes API parse error: "));
        assert!(parse_resource_record::<serde_json::Value>("", "Routes API").is_err());
    }

    #[test]
    fn empty_object_is_empty_record() {
        let rec = parse_resource_record::<serde_json::Value>("{}", "Routes API").unwrap();
        assert!(rec.is_empty());
    }
}
