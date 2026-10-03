//! Shared helpers for the pass-through commands: the canonical demo bundle and
//! its path lookups, identical to `fina_kernel::api`'s own helpers so every
//! transport answers `get_path` with the same semantics.

use fina_kernel::path_generator::{generate_paths, SimulationConfig};
use fina_kernel::types::SimulationBundle;
use fina_kernel::types::SimulationPath;
use fina_kernel::{FinaError, Result};

/// The canonical demo bundle behind every path-indexed command.
pub(crate) fn demo_bundle() -> Result<SimulationBundle> {
    generate_paths(SimulationConfig::demo(), |_| {})
}

/// Looks up a demo path by index.
pub(crate) fn dispatch_demo_path(index: usize) -> Result<SimulationPath> {
    let bundle = demo_bundle()?;
    bundle
        .paths
        .iter()
        .find(|p| p.path_index == index)
        .cloned()
        .ok_or(FinaError::PathOutOfRange {
            index,
            len: bundle.paths.len(),
        })
}
