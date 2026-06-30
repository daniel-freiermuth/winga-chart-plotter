//! Active-course mutation — `/signalk/v2/api/vessels/self/navigation/course*`.
//! Ported from `navigateToPoint`/`clearCourse`/`activateRoute`/
//! `setActiveRoutePointIndex` in `app/src/lib/signalk-api.ts`.

/// Body for `PUT .../course/destination`.
pub fn destination_body(latitude: f64, longitude: f64) -> serde_json::Value {
    serde_json::json!({ "position": { "latitude": latitude, "longitude": longitude } })
}

/// Body for `PUT .../course/activeRoute`.
pub fn active_route_body(route_uuid: &str) -> serde_json::Value {
    serde_json::json!({ "href": format!("/resources/routes/{route_uuid}") })
}

/// Body for `PUT .../course/activeRoute/pointIndex`.
pub fn point_index_body(index: i32) -> serde_json::Value {
    serde_json::json!({ "value": index })
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{active_route_body, destination_body, point_index_body};
    use crate::skrest::http;
    use wasm_bindgen::prelude::*;

    /// Set the active course destination to a single point. Replaces any
    /// existing course (active route or previous waypoint).
    ///   `PUT /signalk/v2/api/vessels/self/navigation/course/destination`
    #[wasm_bindgen(js_name = navigateToPoint)]
    pub async fn navigate_to_point(
        server_base: String,
        latitude: f64,
        longitude: f64,
        auth_headers: JsValue,
    ) -> Result<(), JsValue> {
        let url =
            format!("{server_base}/signalk/v2/api/vessels/self/navigation/course/destination");
        let body = destination_body(latitude, longitude).to_string();
        let resp = http::fetch("PUT", &url, &auth_headers, Some(&body), None).await?;
        if !resp.ok() {
            return Err(http::status_error("Navigate to point failed", &resp));
        }
        Ok(())
    }

    /// Clear the active course (destination point or active route).
    ///   `DELETE /signalk/v2/api/vessels/self/navigation/course`
    #[wasm_bindgen(js_name = clearCourse)]
    pub async fn clear_course(server_base: String, auth_headers: JsValue) -> Result<(), JsValue> {
        let url = format!("{server_base}/signalk/v2/api/vessels/self/navigation/course");
        let resp = http::fetch("DELETE", &url, &auth_headers, None, None).await?;
        if !resp.ok() {
            return Err(http::status_error("Clear course failed", &resp));
        }
        Ok(())
    }

    /// Activate a route as the active course.
    ///   `PUT /signalk/v2/api/vessels/self/navigation/course/activeRoute`
    #[wasm_bindgen(js_name = activateRoute)]
    pub async fn activate_route(
        server_base: String,
        route_uuid: String,
        auth_headers: JsValue,
    ) -> Result<(), JsValue> {
        let url =
            format!("{server_base}/signalk/v2/api/vessels/self/navigation/course/activeRoute");
        let body = active_route_body(&route_uuid).to_string();
        let resp = http::fetch("PUT", &url, &auth_headers, Some(&body), None).await?;
        if !resp.ok() {
            return Err(http::status_error("Activate route failed", &resp));
        }
        Ok(())
    }

    /// Set the active route's current destination to a specific point along it.
    ///   `PUT /signalk/v2/api/vessels/self/navigation/course/activeRoute/pointIndex`
    #[wasm_bindgen(js_name = setActiveRoutePointIndex)]
    pub async fn set_active_route_point_index(
        server_base: String,
        index: i32,
        auth_headers: JsValue,
    ) -> Result<(), JsValue> {
        let url = format!(
            "{server_base}/signalk/v2/api/vessels/self/navigation/course/activeRoute/pointIndex"
        );
        let body = point_index_body(index).to_string();
        let resp = http::fetch("PUT", &url, &auth_headers, Some(&body), None).await?;
        if !resp.ok() {
            return Err(http::status_error("Set route point index failed", &resp));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_body_shape() {
        let b = destination_body(60.17, 24.94);
        assert_eq!(
            b,
            serde_json::json!({ "position": { "latitude": 60.17, "longitude": 24.94 } })
        );
    }

    #[test]
    fn active_route_body_shape() {
        let b = active_route_body("abc-123");
        assert_eq!(
            b,
            serde_json::json!({ "href": "/resources/routes/abc-123" })
        );
    }

    #[test]
    fn point_index_body_shape() {
        assert_eq!(point_index_body(3), serde_json::json!({ "value": 3 }));
    }
}
