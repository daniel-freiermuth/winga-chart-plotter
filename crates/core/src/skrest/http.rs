//! Generic HTTP fetch glue — WASM-only (the browser's `fetch()` has no
//! host-target equivalent). Submodules' pure URL-building/JSON-parsing logic
//! lives outside this file so it stays host-testable; only the actual
//! request/response plumbing crosses into here.

use js_sys::{Object, Reflect};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{AbortSignal, Request, RequestInit, RequestMode, Response};

/// Minimal HTTP response: status code/text + body text.
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub text: String,
}

impl HttpResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Build and dispatch an HTTP request via the browser's `fetch()`, returning
/// the resulting `Promise` immediately (synchronously) — `window.fetch()`
/// starts the network request as soon as it is called, *not* when its
/// promise is later awaited. Callers that need genuine concurrency (e.g.
/// `history`'s 3-way parallel track fetch, mirroring the original TS code's
/// `Promise.allSettled`) MUST call this for every request first, then await
/// each `await_response()` afterwards — awaiting one `fetch()` call before
/// starting the next would serialise requests Rust's futures are lazy.
///
/// `extra_headers` is a plain JS object (typically the TS auth store's
/// `Record<string, string>`, possibly empty) forwarded as-is; when `body`
/// is present a `Content-Type: application/json` header is merged in
/// (matching the original TS call sites' `{ 'Content-Type': ..., ...authHeaders }`
/// spread order — `authHeaders` never legitimately overrides Content-Type).
pub fn start_fetch(
    method: &str,
    url: &str,
    extra_headers: &JsValue,
    body: Option<&str>,
    timeout_ms: Option<u32>,
) -> Result<js_sys::Promise, JsValue> {
    let init = RequestInit::new();
    init.set_method(method);
    init.set_mode(RequestMode::Cors);
    if let Some(b) = body {
        init.set_body(&JsValue::from_str(b));
    }
    if let Some(ms) = timeout_ms {
        init.set_signal(Some(&AbortSignal::timeout_with_u32(ms)));
    }

    let headers: Object = if extra_headers.is_object() {
        extra_headers.clone().unchecked_into()
    } else {
        Object::new()
    };
    if body.is_some() {
        Reflect::set(
            &headers,
            &JsValue::from_str("Content-Type"),
            &JsValue::from_str("application/json"),
        )?;
    }
    init.set_headers_record_from_str_to_str(&headers);

    let request = Request::new_with_str_and_init(url, &init)?;
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("no global window"))?;
    Ok(window.fetch_with_request(&request))
}

/// Await a `Promise` from [`start_fetch`] through to a fully-buffered response.
pub async fn await_response(promise: js_sys::Promise) -> Result<HttpResponse, JsValue> {
    let resp_value = JsFuture::from(promise).await?;
    let resp: Response = resp_value.dyn_into()?;
    let status = resp.status();
    let status_text = resp.status_text();
    let text = JsFuture::from(resp.text()?)
        .await?
        .as_string()
        .unwrap_or_default();
    Ok(HttpResponse {
        status,
        status_text,
        text,
    })
}

/// Single-request convenience wrapper: start + await in one call, for the
/// (common) case where the caller only needs one request at a time.
pub async fn fetch(
    method: &str,
    url: &str,
    extra_headers: &JsValue,
    body: Option<&str>,
    timeout_ms: Option<u32>,
) -> Result<HttpResponse, JsValue> {
    let promise = start_fetch(method, url, extra_headers, body, timeout_ms)?;
    await_response(promise).await
}

/// Build a `js_sys::Error`-backed rejection matching the ported TS code's
/// `throw new Error("<action>: <status> <statusText>")` shape.
pub fn status_error(action: &str, resp: &HttpResponse) -> JsValue {
    JsValue::from(js_sys::Error::new(&format!(
        "{action}: {} {}",
        resp.status, resp.status_text
    )))
}
