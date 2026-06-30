//! Notifications API (the only endpoint currently used: MOB raise). Ported
//! from `raiseMob` in `app/src/lib/signalk-api.ts`. Per ADR-009 non-goals:
//! the full Notifications API (subscribe/ack/resolve arbitrary alarms) is
//! not implemented in TS either — only port what exists.

/// Body for `POST /signalk/v2/api/notifications/mob`.
pub fn mob_body() -> serde_json::Value {
    serde_json::json!({ "message": "Man Overboard!" })
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::mob_body;
    use crate::skrest::http;
    use wasm_bindgen::prelude::*;

    /// Raise a Man Overboard alarm.
    ///   `POST /signalk/v2/api/notifications/mob`
    #[wasm_bindgen(js_name = raiseMob)]
    pub async fn raise_mob(server_base: String, auth_headers: JsValue) -> Result<(), JsValue> {
        let url = format!("{server_base}/signalk/v2/api/notifications/mob");
        let body = mob_body().to_string();
        let resp = http::fetch("POST", &url, &auth_headers, Some(&body), None).await?;
        if !resp.ok() {
            return Err(http::status_error("MOB raise failed", &resp));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mob_body_shape() {
        assert_eq!(
            mob_body(),
            serde_json::json!({ "message": "Man Overboard!" })
        );
    }
}
