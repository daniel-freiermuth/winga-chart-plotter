//! Percent-encoding helpers matching the two JS encoders the ported TS code
//! relied on implicitly: `encodeURIComponent` (path segments, individual
//! query VALUES built by hand) and the `application/x-www-form-urlencoded`
//! serializer `URLSearchParams` uses internally (query strings built via
//! `new URLSearchParams({...})`). The two differ (most notably: space ->
//! `%20` vs `+`, and `!'()*~` stay literal under `encodeURIComponent` but
//! are percent-encoded under form-urlencoded) — using the wrong one would
//! silently drift from the original request shapes.

/// Equivalent to JS `encodeURIComponent`. Unreserved set: `A-Za-z0-9 - _ . ! ~ * ' ( )`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Equivalent to the `application/x-www-form-urlencoded` serializer used by
/// `URLSearchParams`. Unreserved set: `A-Za-z0-9 - . _ *`; space encodes as `+`.
fn encode_form_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'*' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Build a query string from ordered `key=value` pairs, matching
/// `new URLSearchParams({...}).toString()` for a plain-object input
/// (which preserves insertion order).
pub fn form_urlencoded(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", encode_form_value(k), encode_form_value(v)))
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_uri_component_matches_js_semantics() {
        assert_eq!(encode_uri_component("sea,land"), "sea%2Cland");
        assert_eq!(encode_uri_component("image/png"), "image%2Fpng");
        assert_eq!(encode_uri_component("a b"), "a%20b");
        // these stay literal under encodeURIComponent, unlike form-urlencoded
        assert_eq!(encode_uri_component("a!b~c*d'e(f)g"), "a!b~c*d'e(f)g");
        assert_eq!(
            encode_uri_component("urn:mrn:imo:mmsi:230035920"),
            "urn%3Amrn%3Aimo%3Ammsi%3A230035920"
        );
    }

    #[test]
    fn form_urlencoded_matches_urlsearchparams_semantics() {
        assert_eq!(
            form_urlencoded(&[
                ("paths", "navigation.position"),
                ("from", "2026-06-29T12:00:00.000Z")
            ]),
            "paths=navigation.position&from=2026-06-29T12%3A00%3A00.000Z"
        );
        // space -> '+' under form-urlencoded, unlike encodeURIComponent's %20
        assert_eq!(form_urlencoded(&[("a", "b c")]), "a=b+c");
        assert_eq!(form_urlencoded(&[("a", "!b'c")]), "a=%21b%27c");
    }

    #[test]
    fn form_urlencoded_preserves_pair_order() {
        assert_eq!(
            form_urlencoded(&[
                ("context", "vessels.self"),
                ("paths", "navigation.position")
            ]),
            "context=vessels.self&paths=navigation.position"
        );
    }
}
