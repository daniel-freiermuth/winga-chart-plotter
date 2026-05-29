//! Signal K WebSocket client — WASM-only.
//! Owns the connection lifecycle and vessel state accumulation.
//! Calls back into JS when state or connection status changes.

use crate::signalk::{apply_message, extract_ais_binary, extract_vessel_state, prune_stale_vessels, VesselState};
use js_sys::Function;
use signalk::{Storage, V1FullFormat};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{prelude::*, JsCast};
use web_sys::{CloseEvent, ErrorEvent, MessageEvent, WebSocket, WorkerGlobalScope};

/// Connection status reported to JS via `on_status_change`.
#[wasm_bindgen]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

/// Signal K WebSocket client.
///
/// Opens a WebSocket, parses incoming messages in Rust via the `signalk` crate,
/// and calls `on_state_change` whenever navigation state changes, and
/// `on_status_change` whenever the connection status changes.
#[wasm_bindgen]
pub struct SignalKClient {
    ws: WebSocket,
    // Closures must be kept alive for the lifetime of the client.
    _on_open: Closure<dyn FnMut(JsValue)>,
    _on_message: Closure<dyn FnMut(MessageEvent)>,
    _on_error: Closure<dyn FnMut(ErrorEvent)>,
    _on_close: Closure<dyn FnMut(CloseEvent)>,
}

#[wasm_bindgen]
impl SignalKClient {
    /// Create a new client and connect to the given Signal K WebSocket URL.
    ///
    /// - `on_state_change`: called with a serialised `VesselState` object when
    ///   navigation data updates.
    /// - `on_status_change`: called with a `ConnectionStatus` enum value when
    ///   the connection status changes.
    #[wasm_bindgen(constructor)]
    pub fn new(
        url: &str,
        on_state_change: Function,
        on_status_change: Function,
        on_ais_update: Function,
    ) -> Result<SignalKClient, JsValue> {
        let ws = WebSocket::new(url)?;

        let storage: Rc<RefCell<Storage>> =
            Rc::new(RefCell::new(Storage::new(V1FullFormat::default())));

        // onopen — subscribe to self navigation at 500ms and all vessels (AIS) at 1000ms
        let status_cb = on_status_change.clone();
        let ws_clone = ws.clone();
        let on_open = Closure::wrap(Box::new(move |_: JsValue| {
            let subscribe_msg = r#"{
                "context": "vessels.self",
                "subscribe": [
                    {"path": "navigation.position",             "period": 500},
                    {"path": "navigation.courseOverGroundTrue", "period": 500},
                    {"path": "navigation.speedOverGround",      "period": 500},
                    {"path": "navigation.headingTrue",          "period": 500},
                    {"path": "navigation.course",               "period": 1000}
                ]
            }"#;
            let _ = ws_clone.send_with_str(subscribe_msg);
            let ais_subscribe_msg = r#"{
                "context": "vessels.*",
                "subscribe": [
                    {"path": "name",                            "period": 60000},
                    {"path": "navigation.datetime",             "period": 1000},
                    {"path": "navigation.position",             "period": 1000},
                    {"path": "navigation.courseOverGroundTrue", "period": 1000},
                    {"path": "navigation.speedOverGround",      "period": 1000},
                    {"path": "navigation.headingTrue",          "period": 1000},
                    {"path": "navigation.rateOfTurn",           "period": 1000},
                    {"path": "navigation.speedThroughWater",    "period": 1000}
                ]
            }"#;
            let _ = ws_clone.send_with_str(ais_subscribe_msg);
            let _ = status_cb.call1(&JsValue::NULL, &JsValue::from(ConnectionStatus::Connected));
        }) as Box<dyn FnMut(JsValue)>);
        ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));

        // onmessage — parse incoming delta in Rust, then debounce AIS updates.
        //
        // During the initial SignalK burst (~1400 messages) we accumulate all state
        // in storage but only emit AIS at most once every AIS_MAX_INTERVAL_MS.
        // After the burst dies down the debounce timer fires within AIS_DEBOUNCE_MS
        // of the last message, producing one final consistent snapshot.
        // This reduces a potentially O(n²) serialisation cascade to O(1) emits.
        const AIS_DEBOUNCE_MS: i32 = 50;
        const AIS_MAX_INTERVAL_MS: f64 = 500.0;
        const AIS_STALE_MS: f64 = 10.0 * 60.0 * 1000.0; // 10 minutes

        let last_ais_emit: Rc<RefCell<f64>> = Rc::new(RefCell::new(0.0));
        let debounce_handle: Rc<RefCell<Option<i32>>> = Rc::new(RefCell::new(None));

        let storage_clone = storage.clone();
        let state_cb = on_state_change.clone();
        let last_vessel_state: Rc<RefCell<Option<VesselState>>> = Rc::new(RefCell::new(None));
        let last_vessel_state_clone = last_vessel_state.clone();

        // Helper closure that does the actual AIS emit — shared between the immediate
        // path and the debounce timer. Wrapped in Rc so both paths can hold it.
        let emit_ais = {
            let storage = storage_clone.clone();
            let ais_cb = on_ais_update.clone();
            let last_emit = last_ais_emit.clone();
            Rc::new(move || {
                let now_ms = js_sys::Date::now();
                prune_stale_vessels(&mut storage.borrow_mut(), now_ms, AIS_STALE_MS);
                let (hot_arr, ids, cold) = extract_ais_binary(&storage.borrow(), now_ms, AIS_STALE_MS);
                if !ids.is_empty() {
                    let js_ids = js_sys::Array::new_with_length(ids.len() as u32);
                    for (i, id) in ids.iter().enumerate() {
                        js_ids.set(i as u32, JsValue::from_str(id));
                    }
                    let cold_js = serde_wasm_bindgen::to_value(&cold).unwrap_or(JsValue::NULL);
                    let payload = js_sys::Object::new();
                    let _ = js_sys::Reflect::set(&payload, &JsValue::from_str("hot"), &hot_arr.buffer());
                    let _ = js_sys::Reflect::set(&payload, &JsValue::from_str("ids"), &js_ids);
                    let _ = js_sys::Reflect::set(&payload, &JsValue::from_str("cold"), &cold_js);
                    let _ = ais_cb.call1(&JsValue::NULL, &payload);
                }
                *last_emit.borrow_mut() = now_ms;
            })
        };

        let on_message = Closure::wrap(Box::new(move |e: MessageEvent| {
            let Some(text) = e.data().as_string() else { return; };
            if apply_message(&mut storage_clone.borrow_mut(), &text).is_err() { return; }

            // Always forward own-vessel state immediately — it's a single cheap struct.
            let state = extract_vessel_state(&storage_clone.borrow());
            if state.position.is_some() {
                // Only emit when something relevant actually changed — many incoming
                // WebSocket messages are AIS deltas that don't touch own-vessel state.
                let changed = last_vessel_state_clone.borrow().as_ref() != Some(&state);
                if changed {
                    *last_vessel_state_clone.borrow_mut() = Some(state.clone());
                    let js_val = serde_wasm_bindgen::to_value(&state).unwrap_or(JsValue::NULL);
                    let _ = state_cb.call1(&JsValue::NULL, &js_val);
                }
            }

            let now = js_sys::Date::now();
            if now - *last_ais_emit.borrow() >= AIS_MAX_INTERVAL_MS {
                // Max interval exceeded — emit now and cancel any pending debounce.
                if let Some(handle) = debounce_handle.borrow_mut().take() {
                    let scope = js_sys::global()
                        .dyn_into::<WorkerGlobalScope>()
                        .expect("running in a Worker");
                    scope.clear_timeout_with_handle(handle);
                }
                emit_ais();
            } else {
                // Reset the debounce timer.
                if let Some(handle) = debounce_handle.borrow_mut().take() {
                    let scope = js_sys::global()
                        .dyn_into::<WorkerGlobalScope>()
                        .expect("running in a Worker");
                    scope.clear_timeout_with_handle(handle);
                }
                let emit = emit_ais.clone();
                let handle_cell = debounce_handle.clone();
                let cb = Closure::once(Box::new(move || {
                    emit();
                    *handle_cell.borrow_mut() = None;
                }) as Box<dyn FnOnce()>);
                let scope = js_sys::global()
                    .dyn_into::<WorkerGlobalScope>()
                    .expect("running in a Worker");
                let handle = scope
                    .set_timeout_with_callback_and_timeout_and_arguments_0(
                        cb.as_ref().unchecked_ref(),
                        AIS_DEBOUNCE_MS,
                    )
                    .unwrap_or(0);
                cb.forget(); // browser owns the callback now
                *debounce_handle.borrow_mut() = Some(handle);
            }
        }) as Box<dyn FnMut(MessageEvent)>);
        ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        // onerror
        let status_cb = on_status_change.clone();
        let on_error = Closure::wrap(Box::new(move |_e: ErrorEvent| {
            let _ = status_cb.call1(&JsValue::NULL, &JsValue::from(ConnectionStatus::Error));
        }) as Box<dyn FnMut(ErrorEvent)>);
        ws.set_onerror(Some(on_error.as_ref().unchecked_ref()));

        // onclose
        let status_cb = on_status_change.clone();
        let on_close = Closure::wrap(Box::new(move |_e: CloseEvent| {
            let _ = status_cb.call1(&JsValue::NULL, &JsValue::from(ConnectionStatus::Disconnected));
        }) as Box<dyn FnMut(CloseEvent)>);
        ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));

        Ok(SignalKClient {
            ws,
            _on_open: on_open,
            _on_message: on_message,
            _on_error: on_error,
            _on_close: on_close,
        })
    }

    /// Close the underlying WebSocket connection.
    pub fn close(&self) {
        let _ = self.ws.close();
    }
}
