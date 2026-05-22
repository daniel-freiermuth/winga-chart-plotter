//! Signal K WebSocket client — WASM-only.
//! Owns the connection lifecycle and vessel state accumulation.
//! Calls back into JS when state or connection status changes.

use crate::signalk::{apply_message, extract_ais_targets, extract_vessel_state};
use js_sys::Function;
use signalk::{Storage, V1FullFormat};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{prelude::*, JsCast};
use web_sys::{CloseEvent, ErrorEvent, MessageEvent, WebSocket};

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
                    {"path": "navigation.headingTrue",          "period": 500}
                ]
            }"#;
            let _ = ws_clone.send_with_str(subscribe_msg);
            let ais_subscribe_msg = r#"{
                "context": "vessels.*",
                "subscribe": [
                    {"path": "name",                            "period": 60000},
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

        // onmessage — parse in Rust via signalk crate, call back with updated state
        let storage_clone = storage.clone();
        let state_cb = on_state_change.clone();
        let ais_cb = on_ais_update.clone();
        let on_message = Closure::wrap(Box::new(move |e: MessageEvent| {
            let Some(text) = e.data().as_string() else { return; };
            if apply_message(&mut storage_clone.borrow_mut(), &text).is_err() { return; }
            let storage = storage_clone.borrow();
            let state = extract_vessel_state(&storage);
            if state.position.is_some() {
                let js_val = serde_wasm_bindgen::to_value(&state).unwrap_or(JsValue::NULL);
                let _ = state_cb.call1(&JsValue::NULL, &js_val);
            }
            let targets = extract_ais_targets(&storage);
            if !targets.is_empty() {
                let js_val = serde_wasm_bindgen::to_value(&targets).unwrap_or(JsValue::NULL);
                let _ = ais_cb.call1(&JsValue::NULL, &js_val);
            }
        }) as Box<dyn FnMut(MessageEvent)>);
        ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));

        // onerror
        let status_cb = on_status_change.clone();
        let on_error = Closure::wrap(Box::new(move |_: ErrorEvent| {
            let _ = status_cb.call1(&JsValue::NULL, &JsValue::from(ConnectionStatus::Error));
        }) as Box<dyn FnMut(ErrorEvent)>);
        ws.set_onerror(Some(on_error.as_ref().unchecked_ref()));

        // onclose
        let status_cb = on_status_change.clone();
        let on_close = Closure::wrap(Box::new(move |_: CloseEvent| {
            let _ =
                status_cb.call1(&JsValue::NULL, &JsValue::from(ConnectionStatus::Disconnected));
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

    /// Close the WebSocket connection.
    pub fn close(&self) -> Result<(), JsValue> {
        self.ws.close()
    }

    /// Returns the current WebSocket ready state (0=connecting, 1=open, 2=closing, 3=closed).
    pub fn ready_state(&self) -> u16 {
        self.ws.ready_state()
    }
}
