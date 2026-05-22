/// Abstraction over geographic projections.
/// All coordinate math goes through this — never raw lon/lat arithmetic.
pub trait Projection: Send + Sync {
    fn forward(&self, lon: f64, lat: f64) -> (f64, f64);
    fn inverse(&self, x: f64, y: f64) -> (f64, f64);
    fn epsg_code(&self) -> u32;
}

/// Web Mercator (EPSG:3857) — the common default for web maps.
/// Used only as a concrete implementation; do not hardcode this in business logic.
pub struct WebMercator;

impl Projection for WebMercator {
    fn forward(&self, lon: f64, lat: f64) -> (f64, f64) {
        use std::f64::consts::PI;
        let x = lon.to_radians() * 6_378_137.0;
        let y = (PI / 4.0 + lat.to_radians() / 2.0).tan().ln() * 6_378_137.0;
        (x, y)
    }

    fn inverse(&self, x: f64, y: f64) -> (f64, f64) {
        use std::f64::consts::PI;
        let lon = x.to_degrees() / 6_378_137.0;
        let lat = (2.0 * (y / 6_378_137.0).exp().atan() - PI / 2.0).to_degrees();
        (lon, lat)
    }

    fn epsg_code(&self) -> u32 {
        3857
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_origin() {
        let proj = WebMercator;
        let (x, y) = proj.forward(0.0, 0.0);
        let (lon, lat) = proj.inverse(x, y);
        assert!((lon - 0.0).abs() < 1e-9);
        assert!((lat - 0.0).abs() < 1e-9);
    }

    #[test]
    fn round_trip_oslo() {
        let proj = WebMercator;
        let (x, y) = proj.forward(10.75, 59.91);
        let (lon, lat) = proj.inverse(x, y);
        assert!((lon - 10.75).abs() < 1e-6);
        assert!((lat - 59.91).abs() < 1e-6);
    }
}
