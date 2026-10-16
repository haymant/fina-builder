//! RIGA agent host — the chat panel's backend.
//!
//! Mirrors `modules/riga/demo/src-tauri/src/lib.rs`: one `IpcService` around
//! `ServerState` powers the Tauri IPC commands and events the
//! `@rigai/assistant-ui` surface calls. All provider/tool/MCP/session logic lives
//! in `riga-server`; this module is only the adapter.

use riga_kernel::{Agent, Health};
use riga_server::{
    ipc::{Attachment, IpcAttachment, IpcService, ProviderConfigured},
    ws::ProviderConfig,
    CreateSessionRequest, HealthResponse, ServerState,
};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Deserialize)]
pub struct LocalModelActionRequest {
    action: String,
    model_id: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ApprovalRequest {
    run_id: String,
    approval_id: String,
    approved: bool,
    option: Option<String>,
}

#[tauri::command]
pub fn kernel_health(agent: State<'_, Agent>) -> Health {
    agent.health()
}

#[tauri::command]
pub async fn riga_transport_connect(app: AppHandle, service: State<'_, IpcService>) -> Result<(), String> {
    if let Some(configured) = service.provider().await? {
        let _ = app.emit("riga://provider-configured", configured);
    }
    Ok(())
}

#[tauri::command]
pub fn riga_transport_disconnect() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn riga_health(service: State<'_, IpcService>) -> Result<HealthResponse, String> {
    Ok(service.health())
}

#[tauri::command]
pub async fn riga_catalog(service: State<'_, IpcService>) -> Result<serde_json::Value, String> {
    Ok(serde_json::to_value(service.catalog().await).unwrap_or_default())
}

#[tauri::command]
pub async fn riga_list_sessions(service: State<'_, IpcService>) -> Result<Vec<riga_kernel::state::Session>, String> {
    service.list_sessions().await
}

#[tauri::command]
pub async fn riga_list_active_runs(service: State<'_, IpcService>) -> Result<Vec<riga_server::ws::ActiveRun>, String> {
    Ok(service.list_active_runs().await)
}

#[tauri::command]
pub async fn riga_create_session(service: State<'_, IpcService>, request: CreateSessionRequest) -> Result<riga_kernel::state::Session, String> {
    service.create_session(request).await
}

#[tauri::command]
pub async fn riga_session_history(service: State<'_, IpcService>, session_id: String) -> Result<Vec<riga_server::ws::ConversationTurn>, String> {
    Ok(service.session_history(&session_id).await)
}

#[tauri::command]
pub async fn riga_workspace_entries(service: State<'_, IpcService>, session_id: String, path: String) -> Result<Vec<riga_server::files::WorkspaceEntry>, String> {
    service.workspace_dir(&session_id, &path).await
}

#[tauri::command]
pub async fn riga_workspace_file(service: State<'_, IpcService>, session_id: String, path: String) -> Result<riga_server::files::WorkspaceFile, String> {
    service.workspace_file(&session_id, &path).await
}

#[tauri::command]
pub async fn riga_git_status(service: State<'_, IpcService>, session_id: String) -> Result<Vec<riga_server::files::GitChange>, String> {
    service.git_status(&session_id).await
}

#[tauri::command]
pub async fn riga_git_diff(service: State<'_, IpcService>, session_id: String, path: String) -> Result<riga_server::files::WorkspaceDiff, String> {
    service.git_diff(&session_id, &path).await
}

#[tauri::command]
pub async fn riga_git_commit(service: State<'_, IpcService>, session_id: String, message: String) -> Result<riga_server::files::GitCommitResult, String> {
    service.git_commit(&session_id, &message).await
}

#[tauri::command]
pub async fn riga_git_push(service: State<'_, IpcService>, session_id: String) -> Result<riga_server::files::GitPushResult, String> {
    service.git_push(&session_id).await
}

#[tauri::command]
pub async fn riga_git_log(service: State<'_, IpcService>, session_id: String, limit: Option<usize>) -> Result<Vec<riga_server::files::GitCommit>, String> {
    service.git_log(&session_id, limit.unwrap_or(50)).await
}

#[tauri::command]
pub async fn riga_git_commit_diff(service: State<'_, IpcService>, session_id: String, commit: String) -> Result<riga_server::files::WorkspaceDiff, String> {
    service.git_commit_diff(&session_id, &commit).await
}

#[tauri::command]
pub async fn riga_rename_session(service: State<'_, IpcService>, session_id: String, title: String) -> Result<riga_kernel::state::Session, String> {
    service.rename_session(&session_id, title).await
}

#[tauri::command]
pub async fn riga_list_mcp_registry(service: State<'_, IpcService>) -> Result<Vec<riga_server::catalog::McpServerSummary>, String> {
    Ok(service.list_mcp_registry().await)
}

#[tauri::command]
pub async fn riga_save_mcp_registry(service: State<'_, IpcService>, request: riga_server::McpRegistryRequest) -> Result<Vec<riga_server::catalog::McpServerSummary>, String> {
    service.save_mcp_registry(request).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn riga_configure_provider(
    app: AppHandle,
    service: State<'_, IpcService>,
    endpoint: String,
    api_key: String,
    model: String,
    reasoning_effort: String,
    kind: Option<riga_server::ws::ProviderKind>,
    api: Option<riga_server::ws::ProviderApi>,
    subagent_model: Option<String>,
    provider_id: Option<String>,
    provider_type: Option<riga_server::ws::ProviderType>,
) -> Result<ProviderConfigured, String> {
    let configured = service
        .configure_provider(ProviderConfig {
            endpoint,
            api_key,
            model,
            reasoning_effort,
            kind: kind.unwrap_or_default(),
            api: api.unwrap_or_default(),
            subagent_model,
            provider_id,
            provider_type: provider_type.unwrap_or_default(),
        })
        .await?;
    let _ = app.emit("riga://provider-configured", configured.clone());
    Ok(configured)
}

#[tauri::command]
pub async fn riga_remote_models(service: State<'_, IpcService>, provider_id: Option<String>) -> Result<Vec<String>, String> {
    service.remote_models_for(provider_id.as_deref()).await
}

#[tauri::command]
pub async fn riga_provider_profiles(service: State<'_, IpcService>) -> Result<Vec<riga_server::ipc::ProviderProfileSummary>, String> {
    service.provider_profiles().await
}

#[tauri::command]
pub async fn riga_save_provider_profile(service: State<'_, IpcService>, request: riga_server::ipc::ProviderProfileInput) -> Result<riga_server::ipc::ProviderProfileSummary, String> {
    service.save_provider_profile(request).await
}

#[tauri::command]
pub async fn riga_delete_provider_profile(service: State<'_, IpcService>, provider_id: String) -> Result<(), String> {
    service.delete_provider_profile(&provider_id).await
}

pub async fn forward_events(app: AppHandle, mut events: tokio::sync::broadcast::Receiver<riga_kernel::events::RigaEventEnvelope>) {
    while let Ok(event) = events.recv().await {
        let terminal = matches!(
            event.event,
            riga_kernel::events::RigaEvent::RunCompleted { .. } | riga_kernel::events::RigaEvent::RunFailed { .. }
        );
        let _ = app.emit("riga://run-event", event);
        if terminal {
            break;
        }
    }
}

pub async fn forward_local_model_events(app: AppHandle, mut events: tokio::sync::broadcast::Receiver<riga_server::local_model::LocalModelEvent>) {
    while let Ok(event) = events.recv().await {
        if let Ok(payload) = serde_json::to_value(event) {
            let _ = app.emit("riga://local-model-event", payload);
        }
    }
}

#[tauri::command]
pub async fn riga_start_run(app: AppHandle, service: State<'_, IpcService>, run_id: String, session_id: String, prompt: String) -> Result<(), String> {
    let events = service.start_run(run_id, session_id, prompt).await?;
    tauri::async_runtime::spawn(forward_events(app, events));
    Ok(())
}

#[tauri::command]
pub async fn riga_resume_run(app: AppHandle, service: State<'_, IpcService>, run_id: String, after_sequence: u64) -> Result<(), String> {
    let events = service.subscribe_run(&run_id, after_sequence).await?;
    tauri::async_runtime::spawn(forward_events(app, events));
    Ok(())
}

#[tauri::command]
pub async fn riga_cancel_run(service: State<'_, IpcService>, run_id: String) -> Result<(), String> {
    if service.cancel_run(&run_id).await {
        Ok(())
    } else {
        Err("run not found".into())
    }
}

#[tauri::command]
pub async fn riga_respond_to_approval(service: State<'_, IpcService>, request: ApprovalRequest) -> Result<(), String> {
    if service
        .respond_to_approval(&request.approval_id, request.approved, request.option.as_deref() == Some("always"))
        .await
    {
        Ok(())
    } else {
        Err(format!("approval not found for run {}", request.run_id))
    }
}

#[tauri::command]
pub async fn riga_local_models(service: State<'_, IpcService>) -> Result<riga_server::LocalModelOverview, String> {
    Ok(service.local_models().await)
}

#[tauri::command]
pub async fn riga_local_model_action(service: State<'_, IpcService>, request: LocalModelActionRequest) -> Result<(), String> {
    service
        .local_model_action(&request.action, request.model_id.as_deref(), request.path.as_deref())
        .await
}

#[tauri::command]
pub async fn riga_upload_attachment(service: State<'_, IpcService>, attachment: IpcAttachment) -> Result<Attachment, String> {
    service.upload_attachment(attachment).await
}

/// Prepare the desktop workspace and start the in-process service.
pub fn install(app: &tauri::App) {
    // Prefer the repository the app was launched from, so the desktop browses
    // the same per-session worktrees the agent runs in.
    if let Some(root) = std::env::current_dir()
        .ok()
        .and_then(|dir| riga_server::catalog::git_toplevel(&dir))
    {
        std::env::set_var("RIGA_WORKSPACE_ROOT", root);
    }
    if let Err(error) = riga_shell::ensure_workspace(&riga_shell::default_data_dir().join("workspace")) {
        eprintln!("RIGA: could not prepare the desktop workspace: {error}");
    }

    let service = IpcService::new(ServerState::default());
    let local_model_events = service.subscribe_local_models();
    app.manage(service);
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(forward_local_model_events(handle.clone(), local_model_events));

    // Register the vendored engines with the embedded RIGA agent so the chat can
    // call their tools (query_execution_net, price_put, vol_surface, …). This
    // merges with any servers the user already configured in Connectors.
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<IpcService>().state();
        let service = IpcService::new(state);
        let engines = [
            ("riga-flow", crate::mcp_commands::get_riga_mcp_path(handle.clone()), vec!["--transport".to_string(), "stdio".to_string()]),
            ("tac-engine", crate::mcp_commands::get_tac_engine_path(handle.clone()), Vec::new()),
        ];
        for (name, path, args) in engines {
            let Ok(command) = path else {
                eprintln!("RIGA: {name} MCP binary unavailable; the chat will not expose its tools");
                continue;
            };
            let request = riga_server::McpRegistryRequest {
                name: name.to_string(),
                transport: "stdio".to_string(),
                command: Some(command),
                args,
                url: None,
                api_key: None,
            };
            if let Err(error) = service.save_mcp_registry(request).await {
                eprintln!("RIGA: could not register the {name} MCP server: {error}");
            }
        }
        // Connect once at startup so the first run's tools are ready immediately
        // instead of paying for the stdio handshake mid-turn.
        service.connect_mcp().await;
    });
}

