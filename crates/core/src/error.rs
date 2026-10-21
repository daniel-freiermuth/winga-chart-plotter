//! Crate-wide error type.
//!
//! The host-testable core reports failures as typed [`Error`] variants so
//! callers can tell a malformed payload from an HTTP status failure from a
//! JS-bridge serialisation failure. At the `#[wasm_bindgen]` boundary the
//! error is converted exactly once (via `From<Error> for JsValue`) into a
//! `js_sys::Error`, so TS always receives an `Error` instance with a
//! `.message` — never a bare string.
//!
//! Transport failures raised by the browser itself (`fetch()` rejections,
//! `AbortSignal.timeout` `DOMException`s) are deliberately NOT wrapped: they
//! already are JS exception objects, and wrapping them would discard their
//! `name` (e.g. `TimeoutError`).

use wasm_bindgen::JsValue;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A JSON payload (Signal K delta, REST response body) failed to parse.
    /// `context` names the payload, e.g. `"Charts API"`.
    #[error("{context} parse error: {source}")]
    Json {
        context: &'static str,
        source: serde_json::Error,
    },
    /// An HTTP request completed with a non-2xx status. Display matches the
    /// original TS `throw new Error("<action>: <status> <statusText>")`.
    #[error("{action}: {status} {status_text}")]
    Status {
        action: &'static str,
        status: u16,
        status_text: String,
    },
    /// Converting a Rust value into a JS value failed.
    #[error("wasm bridge: {0}")]
    Bridge(#[from] serde_wasm_bindgen::Error),
    /// No `window` global to `fetch()` from (e.g. running inside a worker).
    #[error("no global window")]
    NoWindow,
}

impl Error {
    /// `map_err` adapter tagging a `serde_json` failure with its payload name.
    pub fn json(context: &'static str) -> impl FnOnce(serde_json::Error) -> Self {
        move |source| Self::Json { context, source }
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl From<Error> for JsValue {
    fn from(err: Error) -> Self {
        js_sys::Error::new(&err.to_string()).into()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn status_display_matches_ts_error_shape() {
        let err = Error::Status {
            action: "Charts API error",
            status: 404,
            status_text: "Not Found".to_string(),
        };
        assert_eq!(err.to_string(), "Charts API error: 404 Not Found");
    }

    #[test]
    fn json_keeps_context_and_source() {
        let source = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        let err = Error::json("Routes API")(source);
        assert!(err.to_string().starts_with("Routes API parse error: "));
        assert!(std::error::Error::source(&err).is_some());
    }
}
