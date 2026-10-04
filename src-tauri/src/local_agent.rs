use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use encoding_rs::UTF_8;
use llama_cpp_2::{
    context::{params::LlamaContextParams, LlamaContext},
    llama_backend::LlamaBackend,
    llama_batch::LlamaBatch,
    model::{params::LlamaModelParams, LlamaChatMessage, LlamaModel},
    sampling::LlamaSampler,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const CATALOG: &[CuratedModel] = &[
    CuratedModel {
        id: "qwen2.5-1.5b-instruct",
        name: "Qwen2.5 1.5B Instruct",
        file_name: "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
        download_url: "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
        size_bytes: 986_048_768,
        sha256: "1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370",
        recommended_context: 4096,
        chat_template: "GGUF embedded default (Qwen2.5 / ChatML)",
        license_url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct",
    },
    CuratedModel {
        id: "gemma-2-2b-it",
        name: "Gemma 2 2B IT",
        file_name: "gemma-2-2b-it-Q4_K_M.gguf",
        download_url: "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf",
        size_bytes: 1_708_582_752,
        sha256: "e0aee85060f168f0f2d8473d7ea41ce2f3230c1bc1374847505ea599288a7787",
        recommended_context: 4096,
        chat_template: "GGUF embedded default (Gemma 2)",
        license_url: "https://ai.google.dev/gemma/terms",
    },
    CuratedModel {
        id: "llama-3.2-3b-instruct",
        name: "Llama 3.2 3B Instruct",
        file_name: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        download_url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        size_bytes: 2_019_377_696,
        sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
        recommended_context: 4096,
        chat_template: "GGUF embedded default (Llama 3.2)",
        license_url: "https://www.llama.com/llama3_2/license/",
    },
    CuratedModel {
        id: "phi-3.5-mini-instruct",
        name: "Phi-3.5 Mini Instruct",
        file_name: "Phi-3.5-mini-instruct-Q4_K_M.gguf",
        download_url: "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf",
        size_bytes: 2_393_232_672,
        sha256: "e4165e3a71af97f1b4826f6e0574b88cb6d7e0c5b403f895c62d4c913bbe01a5",
        recommended_context: 4096,
        chat_template: "GGUF embedded default (Phi-3.5)",
        license_url: "https://huggingface.co/microsoft/Phi-3.5-mini-instruct",
    },
    CuratedModel {
        id: "qwen2.5-3b-instruct",
        name: "Qwen2.5 3B Instruct",
        file_name: "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
        download_url: "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf",
        size_bytes: 1_929_903_264,
        sha256: "9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94",
        recommended_context: 4096,
        chat_template: "GGUF embedded default (Qwen2.5 / ChatML)",
        license_url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct",
    },
    CuratedModel {
        id: "phi-4-mini-instruct",
        name: "Phi-4 Mini 3.8B Instruct",
        file_name: "microsoft_Phi-4-mini-instruct-Q4_K_M.gguf",
        download_url: "https://huggingface.co/bartowski/microsoft_Phi-4-mini-instruct-GGUF/resolve/main/microsoft_Phi-4-mini-instruct-Q4_K_M.gguf",
        size_bytes: 2_491_874_688,
        sha256: "01999f17c39cc3074afae5e9c539bc82d45f2dd7faa3917c66cbef76fce8c0c2",
        recommended_context: 4096,
        chat_template: "GGUF embedded default (Phi-4 / ChatML)",
        license_url: "https://huggingface.co/microsoft/Phi-4-mini-instruct",
    },
    CuratedModel {
        id: "gemma-3n-e2b-it",
        name: "Gemma 3n E2B IT",
        file_name: "gemma-3n-E2B-it-Q4_K_M.gguf",
        download_url: "https://huggingface.co/unsloth/gemma-3n-E2B-it-GGUF/resolve/main/gemma-3n-E2B-it-Q4_K_M.gguf",
        size_bytes: 3_026_881_888,
        sha256: "189d42b4303cb1078ea8d00963f437cd6d884069b7ba2ba80b38cd09585dc415",
        recommended_context: 4096,
        chat_template: "GGUF embedded default (Gemma 3n)",
        license_url: "https://ai.google.dev/gemma/terms",
    },
    CuratedModel {
        id: "qwen3-4b-instruct",
        name: "Qwen3 4B",
        file_name: "Qwen_Qwen3-4B-Q4_K_M.gguf",
        download_url: "https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q4_K_M.gguf",
        size_bytes: 2_497_280_960,
        sha256: "fbe1d5edd4ce802ae3ae7c7e4ab7d09789d697fdac1fc7929f8df4ca3c41bae3",
        recommended_context: 4096,
        chat_template: "GGUF embedded default (Qwen3 / ChatML)",
        license_url: "https://huggingface.co/Qwen/Qwen3-4B",
    },
];

#[derive(Clone, Copy)]
struct CuratedModel {
    id: &'static str,
    name: &'static str,
    file_name: &'static str,
    download_url: &'static str,
    size_bytes: u64,
    sha256: &'static str,
    recommended_context: u32,
    chat_template: &'static str,
    license_url: &'static str,
}

#[derive(Default)]
pub struct LocalAgentRuntime {
    /// `LlamaBackend::init` may only run once per process, so it is created
    /// lazily here and shared across every model (re)load.
    backend: OnceLock<Arc<LlamaBackend>>,
    engine: Arc<Mutex<Option<LoadedModel>>>,
    downloads: Arc<Mutex<HashMap<String, CancellationToken>>>,
    generations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// Rust-owned connection to the bundled `fina-mcp` stdio server.
    mcp: Arc<crate::mcp::McpRuntime>,
}

impl LocalAgentRuntime {
    /// Shared handle to the MCP runtime for `spawn_blocking` closures.
    pub fn mcp_handle(&self) -> Arc<crate::mcp::McpRuntime> {
        self.mcp.clone()
    }
}

struct LoadedModel {
    // Drop the model before its backend.
    model: LlamaModel,
    backend: Arc<LlamaBackend>,
    file_name: String,
    recommended_context: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub app_data_dir: String,
    pub models_dir: String,
    pub sessions_dir: String,
    pub config_file: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub path: String,
    pub size_bytes: u64,
    pub curated: bool,
    pub recommended_context: Option<u32>,
    pub chat_template: Option<String>,
    pub license_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceEvent {
    pub generation_id: String,
    pub delta: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceRequest {
    pub generation_id: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
}

fn default_max_tokens() -> u32 {
    512
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub title: String,
    pub updated_at: u64,
    pub message_count: usize,
}

fn app_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let models = root.join("models");
    let sessions = root.join("sessions");
    fs::create_dir_all(&models).map_err(|e| format!("Could not create models folder: {e}"))?;
    fs::create_dir_all(&sessions).map_err(|e| format!("Could not create sessions folder: {e}"))?;
    Ok(AppPaths {
        app_data_dir: root.to_string_lossy().into_owned(),
        models_dir: models.to_string_lossy().into_owned(),
        sessions_dir: sessions.to_string_lossy().into_owned(),
        config_file: root.join("config.json").to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn get_app_paths(app: AppHandle) -> Result<AppPaths, String> {
    app_paths(&app)
}

/// Persist a frontend error so a webview failure is diagnosable after the fact.
/// Also mirrored to stderr, which `tauri dev` shows in the terminal.
#[tauri::command]
pub fn report_frontend_error(
    app: AppHandle,
    context: String,
    message: String,
) -> Result<(), String> {
    let line = format!(
        "[{}] {context}: {message}\n",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default()
    );
    eprintln!("frontend-error {}", line.trim_end());
    if let Ok(paths) = app_paths(&app) {
        let path = std::path::PathBuf::from(paths.app_data_dir).join("frontend-errors.log");
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = std::io::Write::write_all(&mut file, line.as_bytes());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn curated_model_catalog() -> Vec<Value> {
    CATALOG
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "name": m.name,
                "fileName": m.file_name,
                "downloadUrl": m.download_url,
                "sizeBytes": m.size_bytes,
                "sha256": m.sha256,
                "recommendedContext": m.recommended_context,
                "chatTemplate": m.chat_template,
                "licenseUrl": m.license_url,
                "quant": "Q4_K_M"
            })
        })
        .collect()
}

#[tauri::command]
pub fn list_local_models(app: AppHandle) -> Result<Vec<LocalModel>, String> {
    let paths = app_paths(&app)?;
    let dir = PathBuf::from(paths.models_dir);
    let mut models = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("Could not scan models folder: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file()
            || !path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("gguf"))
        {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        let catalog = CATALOG.iter().find(|m| m.file_name == file_name);
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        models.push(LocalModel {
            id: catalog
                .map(|m| m.id.to_string())
                .unwrap_or_else(|| file_name.to_string()),
            name: catalog
                .map(|m| m.name.to_string())
                .unwrap_or_else(|| file_name.to_string()),
            file_name: file_name.to_string(),
            path: path.to_string_lossy().into_owned(),
            size_bytes: metadata.len(),
            curated: catalog.is_some(),
            recommended_context: catalog.map(|m| m.recommended_context),
            chat_template: catalog.map(|m| m.chat_template.to_string()),
            license_url: catalog.map(|m| m.license_url.to_string()),
        });
    }
    models.sort_by_key(|a| a.name.to_lowercase());
    Ok(models)
}

#[tauri::command]
pub fn open_models_folder(app: AppHandle) -> Result<(), String> {
    let paths = app_paths(&app)?;
    app.opener()
        .open_path(paths.models_dir, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_model_download(
    app: AppHandle,
    state: State<'_, LocalAgentRuntime>,
    model_id: String,
) -> Result<(), String> {
    let model = CATALOG
        .iter()
        .find(|m| m.id == model_id)
        .copied()
        .ok_or("Unknown curated model")?;
    let cancel = CancellationToken::new();
    {
        let mut jobs = state
            .downloads
            .lock()
            .map_err(|_| "Download state is unavailable")?;
        if jobs.contains_key(&model_id) {
            return Err("This model is already downloading".into());
        }
        jobs.insert(model_id.clone(), cancel.clone());
    }
    let outcome = async {
        let paths = app_paths(&app)?;
        let directory = PathBuf::from(paths.models_dir);
        let final_path = directory.join(model.file_name);
        let partial_path = directory.join(format!("{}.part", model.file_name));
        let client = reqwest::Client::builder().user_agent("FinaBuilder/0.1 local model downloader").build().map_err(|e| e.to_string())?;
        let mut response = client.get(model.download_url).send().await.map_err(|e| format!("Download request failed: {e}"))?.error_for_status().map_err(|e| format!("Model host returned an error: {e}"))?;
        let mut file = tokio::fs::File::create(&partial_path).await.map_err(|e| format!("Could not create partial model file: {e}"))?;
        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err("Download cancelled".to_string()),
                chunk = response.chunk() => chunk.map_err(|e| format!("Model download interrupted: {e}"))?,
            };
            let Some(chunk) = next else { break };
            downloaded += chunk.len() as u64;
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| format!("Could not write model data: {e}"))?;
            let progress = DownloadProgress {
                model_id: model_id.clone(),
                downloaded_bytes: downloaded,
                total_bytes: model.size_bytes,
                percent: (downloaded as f64 / model.size_bytes as f64 * 100.0).min(100.0),
            };
            let _ = app.emit("model-download-progress", progress);
        }
        file.flush().await.map_err(|e| e.to_string())?;
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        if downloaded != model.size_bytes {
            return Err(format!("Downloaded size mismatch: expected {} bytes, received {downloaded}", model.size_bytes));
        }
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != model.sha256 {
            return Err("Model SHA-256 verification failed; the incomplete file was discarded".into());
        }
        tokio::fs::rename(&partial_path, &final_path).await.map_err(|e| format!("Could not finalize model file: {e}"))?;
        let _ = app.emit("model-download-finished", json!({"modelId": model_id, "path": final_path}));
        Ok(())
    }.await;
    if let Err(error) = &outcome {
        if let Ok(paths) = app_paths(&app) {
            let partial = PathBuf::from(paths.models_dir).join(format!("{}.part", model.file_name));
            let _ = tokio::fs::remove_file(partial).await;
        }
        let _ = app.emit(
            "model-download-error",
            json!({"modelId": model_id, "message": error}),
        );
    }
    if let Ok(mut jobs) = state.downloads.lock() {
        jobs.remove(&model_id);
    }
    outcome
}

#[tauri::command]
pub fn cancel_model_download(
    state: State<'_, LocalAgentRuntime>,
    model_id: String,
) -> Result<(), String> {
    let jobs = state
        .downloads
        .lock()
        .map_err(|_| "Download state is unavailable")?;
    let Some(token) = jobs.get(&model_id) else {
        return Err("No active download for this model".into());
    };
    token.cancel();
    Ok(())
}

fn allowed_model_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let paths = app_paths(app)?;
    let root = PathBuf::from(paths.models_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let candidate = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("Model file not found: {e}"))?;
    if !candidate.starts_with(&root)
        || !candidate.is_file()
        || !candidate
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("gguf"))
    {
        return Err("Choose a .gguf file inside the application models folder".into());
    }
    Ok(candidate)
}

#[tauri::command]
pub async fn load_model(
    app: AppHandle,
    state: State<'_, LocalAgentRuntime>,
    path: String,
) -> Result<(), String> {
    let path = allowed_model_path(&app, &path)?;
    let preferred_path = path.to_string_lossy().into_owned();
    let model_path = path.clone();
    let engine = state.engine.clone();
    // Initialize the process-wide llama.cpp backend at most once. Reusing the
    // existing handle is what lets a second `Load model` succeed instead of
    // failing with `BackendAlreadyInitialized`.
    let backend = match state.backend.get() {
        Some(backend) => backend.clone(),
        None => {
            let candidate = Arc::new(
                LlamaBackend::init().map_err(|e| format!("Could not initialize llama.cpp: {e}"))?,
            );
            let _ = state.backend.set(candidate);
            state
                .backend
                .get()
                .ok_or("Could not initialize llama.cpp: backend unavailable")?
                .clone()
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        let params = LlamaModelParams::default();
        let model = LlamaModel::load_from_file(&backend, &model_path, &params).map_err(|e| format!("Model could not be loaded (the GGUF may be corrupt or exceed available memory): {e}"))?;
        let file_name = model_path.file_name().and_then(|s| s.to_str()).unwrap_or("local model").to_string();
        let catalog = CATALOG.iter().find(|m| m.file_name == file_name);
        let recommended_context = catalog.map(|m| m.recommended_context).unwrap_or_else(|| model.n_ctx_train().clamp(1024, 4096));
        let loaded = LoadedModel { model, backend, file_name, recommended_context };
        *engine.lock().map_err(|_| "Model engine state is unavailable")? = Some(loaded);
        Ok::<(), String>(())
    }).await.map_err(|e| format!("Model-loading worker failed: {e}"))??;
    persist_config(&app, Some(preferred_path))?;
    Ok(())
}

#[tauri::command]
pub fn unload_model(state: State<'_, LocalAgentRuntime>) -> Result<(), String> {
    *state
        .engine
        .lock()
        .map_err(|_| "Model engine state is unavailable")? = None;
    Ok(())
}

#[tauri::command]
pub fn get_loaded_model(state: State<'_, LocalAgentRuntime>) -> Result<Option<String>, String> {
    let engine = state
        .engine
        .lock()
        .map_err(|_| "Model engine state is unavailable")?;
    Ok(engine.as_ref().map(|m| m.file_name.clone()))
}

#[tauri::command]
pub fn cancel_local_inference(
    state: State<'_, LocalAgentRuntime>,
    generation_id: String,
) -> Result<(), String> {
    let generations = state
        .generations
        .lock()
        .map_err(|_| "Inference state is unavailable")?;
    let Some(cancel) = generations.get(&generation_id) else {
        return Err("No active generation".into());
    };
    cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn run_local_inference(
    app: AppHandle,
    state: State<'_, LocalAgentRuntime>,
    request: InferenceRequest,
) -> Result<String, String> {
    let generation_id = request.generation_id.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .generations
        .lock()
        .map_err(|_| "Inference state is unavailable")?
        .insert(generation_id.clone(), cancel.clone());
    let engine = state.engine.clone();
    let app2 = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let guard = engine
            .lock()
            .map_err(|_| "Model engine state is unavailable")?;
        let loaded = guard.as_ref().ok_or("Load a local model before chatting")?;
        generate(loaded, &request, &cancel, &app2)
    })
    .await
    .map_err(|e| format!("Inference worker failed: {e}"))?;
    if let Ok(mut generations) = state.generations.lock() {
        generations.remove(&generation_id);
    }
    outcome
}

fn generate(
    loaded: &LoadedModel,
    request: &InferenceRequest,
    cancel: &AtomicBool,
    app: &AppHandle,
) -> Result<String, String> {
    let messages = request
        .messages
        .iter()
        .filter_map(|message| {
            let role = match message.role.as_str() {
                "system" => "system",
                "assistant" => "assistant",
                "user" => "user",
                "tool" | "toolResult" => "tool",
                _ => return None,
            };
            LlamaChatMessage::new(role.to_string(), message.content.clone()).ok()
        })
        .collect::<Vec<_>>();
    if messages.is_empty() {
        return Err("Enter a message to start a conversation".into());
    }
    let template = loaded
        .model
        .chat_template(None)
        .map_err(|e| format!("The model does not provide a supported chat template: {e}"))?;
    let prompt = loaded
        .model
        .apply_chat_template(&template, &messages, true)
        .map_err(|e| format!("Could not format the chat prompt: {e}"))?;
    let tokens = loaded.model.vocab().tokenize(prompt.as_bytes(), true, true);
    if tokens.is_empty() {
        return Err("The model tokenizer returned an empty prompt".into());
    }
    let context_size = loaded.recommended_context.max(1024);
    if tokens.len() as u32 + request.max_tokens > context_size {
        return Err(format!("Conversation too long for the configured {context_size}-token context; start a new chat or reduce history"));
    }
    let ctx_params =
        LlamaContextParams::default().with_n_ctx(std::num::NonZeroU32::new(context_size));
    let mut ctx: LlamaContext = loaded
        .model
        .new_context(&loaded.backend, ctx_params)
        .map_err(|e| format!("Could not create inference context: {e}"))?;
    let mut batch = LlamaBatch::new(tokens.len().max(1), 1);
    let last = tokens.len() as i32 - 1;
    for (i, token) in tokens.into_iter().enumerate() {
        batch
            .add(token, i as i32, &[0], i as i32 == last)
            .map_err(|e| format!("Could not prepare prompt: {e}"))?;
    }
    ctx.decode(&mut batch)
        .map_err(|e| format!("Could not evaluate prompt: {e}"))?;
    let mut sampler =
        LlamaSampler::chain_simple([LlamaSampler::temp(0.25), LlamaSampler::dist(42)]);
    let mut decoder = UTF_8.new_decoder();
    let mut text = String::new();
    let max_tokens = request.max_tokens.clamp(1, 2048) as usize;
    // The prompt occupies positions 0..n_tokens, so generation starts at
    // `batch.n_tokens()` and advances by one per sampled token.
    let first_position = batch.n_tokens();
    for position in (first_position..).take(max_tokens) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        sampler.accept(token);
        if loaded.model.vocab().is_eog(token) {
            break;
        }
        let piece = loaded.model.vocab().token_to_piece(token, true, None);
        let mut delta = String::with_capacity(
            decoder
                .max_utf8_buffer_length(piece.len())
                .unwrap_or(piece.len() + 4),
        );
        let _ = decoder.decode_to_string(&piece, &mut delta, false);
        if !delta.is_empty() {
            text.push_str(&delta);
            let _ = app.emit(
                "llm-token",
                InferenceEvent {
                    generation_id: request.generation_id.clone(),
                    delta,
                    text: text.clone(),
                },
            );
        }
        batch.clear();
        batch
            .add(token, position, &[0], true)
            .map_err(|e| e.to_string())?;
        ctx.decode(&mut batch)
            .map_err(|e| format!("Token decoding failed: {e}"))?;
    }
    let _ = app.emit(
        "llm-turn-end",
        json!({"generationId": request.generation_id, "cancelled": cancel.load(Ordering::Relaxed)}),
    );
    Ok(text)
}

fn safe_session_id(id: &str) -> Result<&str, String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid session id".into());
    }
    Ok(id)
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[tauri::command]
pub fn save_local_agent_session(
    app: AppHandle,
    session_id: String,
    title: String,
    messages: Vec<Value>,
) -> Result<(), String> {
    safe_session_id(&session_id)?;
    let paths = app_paths(&app)?;
    let path = PathBuf::from(paths.sessions_dir).join(format!("{session_id}.jsonl"));
    let mut output = String::new();
    output.push_str(&serde_json::to_string(&json!({"type":"session","version":3,"id":session_id,"title":title,"timestamp":now_epoch()})).map_err(|e| e.to_string())?);
    output.push('\n');
    let mut parent: Option<String> = None;
    for (index, message) in messages.iter().enumerate() {
        let id = format!("m{index}");
        output.push_str(&serde_json::to_string(&json!({"type":"message","id":id,"parentId":parent,"timestamp":now_epoch(),"message":message})).map_err(|e| e.to_string())?);
        output.push('\n');
        parent = Some(id);
    }
    fs::write(path, output).map_err(|e| format!("Could not persist session: {e}"))
}

#[tauri::command]
pub fn list_local_agent_sessions(app: AppHandle) -> Result<Vec<SessionSummary>, String> {
    let paths = app_paths(&app)?;
    let mut sessions = Vec::new();
    for entry in fs::read_dir(paths.sessions_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let content = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
        let mut lines = content.lines();
        let Some(header) = lines
            .next()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
        else {
            continue;
        };
        let id = header
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if safe_session_id(&id).is_err() {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        sessions.push(SessionSummary {
            session_id: id,
            title: header
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Local chat")
                .to_string(),
            updated_at: metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            message_count: lines.count(),
        });
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub fn load_local_agent_session(app: AppHandle, session_id: String) -> Result<Vec<Value>, String> {
    safe_session_id(&session_id)?;
    let paths = app_paths(&app)?;
    let content =
        fs::read_to_string(PathBuf::from(paths.sessions_dir).join(format!("{session_id}.jsonl")))
            .map_err(|e| e.to_string())?;
    let mut messages = Vec::new();
    for line in content.lines().skip(1) {
        let value: Value =
            serde_json::from_str(line).map_err(|e| format!("Invalid session data: {e}"))?;
        if let Some(message) = value.get("message") {
            messages.push(message.clone());
        }
    }
    Ok(messages)
}

fn persist_config(app: &AppHandle, preferred_model: Option<String>) -> Result<(), String> {
    let paths = app_paths(app)?;
    let path = PathBuf::from(paths.config_file);
    let existing: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_else(|| json!({}));
    let mut config = existing.as_object().cloned().unwrap_or_default();
    if let Some(model) = preferred_model {
        config.insert("preferredModelPath".into(), Value::String(model));
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_preferred_model(app: AppHandle) -> Result<Option<String>, String> {
    let paths = app_paths(&app)?;
    let config: Value = fs::read_to_string(paths.config_file)
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_else(|| json!({}));
    Ok(config
        .get("preferredModelPath")
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// Resolve the `fina-mcp` stdio server binary so the webview can spawn it as an
/// MCP sidecar. Precedence: explicit `FINA_MCP_BIN` override, the packaged
/// sidecar next to the app executable, then a workspace `target/` build for
/// `npm run tauri:dev` and tests.
#[tauri::command]
pub fn get_mcp_server_path(app: AppHandle) -> Result<String, String> {
    if let Ok(explicit) = std::env::var("FINA_MCP_BIN") {
        if std::path::Path::new(&explicit).is_file() {
            return Ok(explicit);
        }
    }
    let exe_name = if cfg!(windows) {
        "fina-mcp.exe"
    } else {
        "fina-mcp"
    };
    // Packaged sidecars live in the bundle's resource directory.
    if let Ok(resources) = app.path().resource_dir() {
        for candidate in [
            resources.join(exe_name),
            resources.join("binaries").join(exe_name),
        ] {
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(exe_name);
            if sidecar.is_file() {
                return Ok(sidecar.to_string_lossy().into_owned());
            }
        }
    }
    // Dev fallback: the workspace target directory, preferring a debug build.
    let manifest = env!("CARGO_MANIFEST_DIR");
    for profile in ["debug", "release"] {
        let candidate = std::path::Path::new(manifest)
            .join("..")
            .join("target")
            .join(profile)
            .join(exe_name);
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err(
        "fina-mcp binary not found. Build it with `cargo build -p fina-mcp`, or set FINA_MCP_BIN."
            .into(),
    )
}

/// Connect to the bundled `fina-mcp` server (if needed) and return its
/// advertised tools. The child process is owned by the Rust runtime.
#[tauri::command]
pub async fn mcp_list_tools(
    app: AppHandle,
    state: State<'_, LocalAgentRuntime>,
) -> Result<Value, String> {
    let binary = get_mcp_server_path(app)?;
    let mcp = state.mcp_handle();
    tauri::async_runtime::spawn_blocking(move || {
        let (server, version, tools) = mcp.list_tools(&binary)?;
        Ok::<Value, String>(json!({
            "server": server,
            "version": version,
            "tools": tools,
        }))
    })
    .await
    .map_err(|e| format!("MCP worker failed: {e}"))?
}

/// Invoke one MCP tool through the Rust-owned connection.
#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, LocalAgentRuntime>,
    name: String,
    arguments: Option<Value>,
) -> Result<crate::mcp::McpCallResult, String> {
    let mcp = state.mcp_handle();
    let arguments = arguments.unwrap_or_else(|| json!({}));
    tauri::async_runtime::spawn_blocking(move || mcp.call_tool(&name, arguments))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

/// Drop the MCP connection so the next call respawns the server.
#[tauri::command]
pub fn mcp_reset(state: State<'_, LocalAgentRuntime>) -> Result<(), String> {
    state.mcp_handle().try_reset();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curated_catalog_has_unique_fully_hashed_entries() {
        assert_eq!(CATALOG.len(), 8);
        let mut ids = std::collections::HashSet::new();
        let mut file_names = std::collections::HashSet::new();
        for model in CATALOG {
            assert!(ids.insert(model.id));
            assert!(file_names.insert(model.file_name));
            assert!(
                model.sha256.len() == 64 && model.sha256.chars().all(|c| c.is_ascii_hexdigit())
            );
            assert!(model.download_url.starts_with("https://"));
            assert!(model.file_name.ends_with(".gguf"));
        }
    }

    #[test]
    fn session_id_rejects_path_traversal() {
        assert!(safe_session_id("../secret").is_err());
        assert!(safe_session_id("session-1").is_ok());
    }

    #[test]
    fn curated_model_catalog_serves_every_field_the_model_picker_renders() {
        let catalog = curated_model_catalog();
        assert_eq!(catalog.len(), CATALOG.len());
        for (entry, source) in catalog.iter().zip(CATALOG.iter()) {
            // The picker keys downloads off `id` and matches on-disk files by
            // `fileName`, so a renamed field would silently break the list.
            assert_eq!(entry["id"], json!(source.id));
            assert_eq!(entry["fileName"], json!(source.file_name));
            assert_eq!(entry["name"], json!(source.name));
            assert_eq!(entry["downloadUrl"], json!(source.download_url));
            assert_eq!(entry["sizeBytes"], json!(source.size_bytes));
            assert_eq!(entry["sha256"], json!(source.sha256));
            assert_eq!(
                entry["recommendedContext"],
                json!(source.recommended_context)
            );
            assert_eq!(entry["chatTemplate"], json!(source.chat_template));
            assert_eq!(entry["licenseUrl"], json!(source.license_url));
            assert_eq!(entry["quant"], json!("Q4_K_M"));
        }
    }

    #[test]
    fn inference_request_defaults_max_tokens_when_the_webview_omits_it() {
        // The frontend always sends `maxTokens`, but a stale bundle or a
        // hand-written call must not silently request zero tokens.
        let request: InferenceRequest = serde_json::from_value(json!({
            "generationId": "gen-1",
            "messages": [{"role": "user", "content": "hi"}],
        }))
        .expect("request without maxTokens must deserialize");
        assert_eq!(request.max_tokens, 512);
        assert_eq!(request.generation_id, "gen-1");

        let explicit: InferenceRequest = serde_json::from_value(json!({
            "generationId": "gen-2",
            "messages": [],
            "maxTokens": 64,
        }))
        .expect("explicit maxTokens must deserialize");
        assert_eq!(explicit.max_tokens, 64);
    }
}
