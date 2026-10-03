//! Path-domain pass-through commands.

use fina_kernel::api::{GeneratePathsRequest, PathRequest};
use fina_kernel::execution::execution_events as kernel_execution_events;
use fina_kernel::path_generator::generate_paths as kernel_generate_paths;
use fina_kernel::progress::ProgressEvent;
use fina_kernel::types::{BranchStats, SimulationBundle, SimulationDistributions, SimulationPath};
use fina_kernel::{ExecutionEvent, FinaErrorWire};

/// `generate_paths` — the only streaming command. Progress events are forwarded
/// straight to the Tauri channel.
#[tauri::command]
pub fn generate_paths(
    req: GeneratePathsRequest,
    on_event: tauri::ipc::Channel<ProgressEvent>,
) -> Result<SimulationBundle, FinaErrorWire> {
    kernel_generate_paths(req.config, |e| {
        let _ = on_event.send(e);
    })
    .map_err(FinaErrorWire::from)
}

/// `get_path`.
#[tauri::command]
pub fn get_path(req: PathRequest) -> Result<SimulationPath, FinaErrorWire> {
    crate::commands::dispatch_demo_path(req.path_index).map_err(FinaErrorWire::from)
}

/// `get_branch_stats`.
#[tauri::command]
pub fn get_branch_stats() -> Result<BranchStats, FinaErrorWire> {
    crate::commands::demo_bundle()
        .map(|b| b.branch_stats)
        .map_err(FinaErrorWire::from)
}

/// `get_distributions`.
#[tauri::command]
pub fn get_distributions() -> Result<SimulationDistributions, FinaErrorWire> {
    crate::commands::demo_bundle()
        .map(|b| b.distributions)
        .map_err(FinaErrorWire::from)
}

/// `execution_events`.
#[tauri::command]
pub fn execution_events(req: PathRequest) -> Result<Vec<ExecutionEvent>, FinaErrorWire> {
    crate::commands::dispatch_demo_path(req.path_index)
        .map(|p| kernel_execution_events(&p))
        .map_err(FinaErrorWire::from)
}
