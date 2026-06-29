pub mod geo;
pub mod projection;
pub mod skdata;

#[cfg(target_arch = "wasm32")]
pub mod client;

pub use projection::{Projection, WebMercator};
pub use skdata::{Position, VesselState};

#[cfg(target_arch = "wasm32")]
pub use client::{ConnectionStatus, SignalKClient};
