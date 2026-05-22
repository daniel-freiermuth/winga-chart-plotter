//! Signal K WebSocket client — WASM-only.
//! Owns the connection lifecycle and vessel state accumulation.
//! Calls back into JS when state or connection status changes.

use crate::signalk::{apply_signalk_delta, VesselState};
use js_sys::Function;
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
/// Opens a WebSocket, parses incoming deltas in Rust, and calls
/// `on_state_change` whenever navigation state changes, and
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
    ) -> Result<SignalKClient, JsValue> {
        let ws = WebSocket::new(url)?;

        let state: Rc<RefCell<VesselState>> = Rc::new(RefCell::new(VesselState::new()));

        // onopen
        let status_cb = on_status_change.clone();
        let on_open = Closure::wrap(Box::new(move |_: JsValue| {
            let _ = status_cb.call1(&JsValue::NULL, &JsValue::from(ConnectionStatus::Connected));
        }) as Box<dyn FnMut(JsValue)>);
        ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));

        // onmessage — parse delta in Rust, call back with updated state
        let state_clone = state.clone();
        let state_cb = on_state_change.clone();
        let on_message = Closure::wrap(Box::new(move |e: MessageEvent| {
            let Some(text) = e.data().as_string() else {
                return;
            };
            let current = state_clone.borrow().clone();
            let Ok(new_state) = apply_signalk_delta(&current, &text) else {
                return;
            };
            *state_clone.borrow_mut() = new_state.clone();
            if new_state.position.is_some() {
                let js_val = serde_wasm_bindgen::to_value(&new_state).unwrap_or(JsValue::NULL);
                let _ = state_cb.call1(&JsValue::NULL, &js_val);
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
