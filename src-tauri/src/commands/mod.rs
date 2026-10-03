//! Tauri IPC command surface over [`fina_kernel`].
//!
//! Every command in this tree is a **pure pass-through**: deserialise the wire
//! request (`fina_kernel::api::*`), call one kernel function, return the core
//! type. Zero formulas, zero defaults, zero branching on domain values — the
//! same wire contract (`FEATURES.md` §5.0) the CLI and the HTTP
//! server speak, so a reviewer can confirm each command is a few lines and
//! nothing more.
//!
//! Errors are reported as [`fina_kernel::FinaErrorWire`], which serialises to
//! the same `{"code","message"}` shape as the other transports.
//!
//! The command *names* are the Rust fn names (`generate_paths`, `compute_risk`,
//! …), which the frontend's `@tauri-apps/api/core` `invoke` spells the same way
//! (I-3).

pub mod diagnostics;
mod dispatch;
pub mod economics;
pub mod path_generator;
pub mod risk_engine;
pub mod valuation;

pub(crate) use dispatch::{demo_bundle, dispatch_demo_path};
