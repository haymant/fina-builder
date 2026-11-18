//! The independent `comfy` workflow pack as an external audio/video tool.
//!
//! fina-builder does not own those graphs. It resolves a checkout, optionally
//! clones the configured repository into the working tree, and reports whether
//! the documented CLI and the loopback ComfyUI server are ready. Audio/video
//! processing itself stays behind `scripts/render.py`.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;

use crate::config::NipConfig;

const CLONE_TIMEOUT: Duration = Duration::from_secs(300);
const PROBE_TIMEOUT: Duration = Duration::from_millis(2_500);
static CLONE_LOCK: Mutex<()> = Mutex::new(());

/// Everything the UI needs to explain why local ASR is (not) available. The
/// desktop shows these blockers verbatim instead of a dead button.
#[derive(Debug, Clone, Serialize)]
pub struct ComfyAsrStatus {
    pub ready: bool,
    pub configured: bool,
    pub comfyui_url: Option<String>,
    pub workspace: String,
    pub workspace_present: bool,
    pub render_script: String,
    pub render_script_present: bool,
    pub repo_url: Option<String>,
    pub chunk_seconds: u32,
    pub python: String,
    pub python_present: bool,
    pub ffmpeg_present: bool,
    pub server_reachable: bool,
    pub server_device: Option<String>,
    pub asr_nodes_present: bool,
    pub pack_commit: Option<String>,
    pub blockers: Vec<String>,
    pub next_actions: Vec<String>,
}

impl ComfyAsrStatus {
    pub fn collect(config: &NipConfig) -> Self {
        let comfy = config.comfy();
        let workspace_present = comfy.workspace().is_dir();
        let render_script_present = comfy.render_script().is_file();
        let python = std::env::var("NIP_PYTHON_BIN")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "python3".to_owned());
        let python_present = binary_available(&python, &["--version"]);
        let ffmpeg_present = binary_available("ffmpeg", &["-version"]);
        let comfyui_url = config
            .resolve_comfyui_url()
            .map(|url| url.as_str().to_owned());
        let (server_reachable, server_device, asr_nodes_present) = match comfyui_url.as_deref() {
            Some(url) => probe_server(url),
            None => (false, None, false),
        };
        let mut blockers = Vec::new();
        let mut next_actions = Vec::new();
        if config.test_mode() {
            return Self {
                ready: true,
                configured: true,
                comfyui_url,
                workspace: comfy.workspace().display().to_string(),
                workspace_present,
                render_script: comfy.render_script().display().to_string(),
                render_script_present,
                repo_url: comfy.repo().map(str::to_owned),
                chunk_seconds: comfy.chunk_seconds(),
                python,
                python_present,
                ffmpeg_present,
                server_reachable,
                server_device,
                asr_nodes_present,
                pack_commit: pack_commit(comfy.workspace()),
                blockers,
                next_actions,
            };
        }
        if comfyui_url.is_none() {
            blockers.push(
                "no loopback ComfyUI endpoint could be resolved; NIP will not send audio to a remote ASR service."
                    .into(),
            );
            next_actions.push(
                "Start ComfyUI Desktop (or set NIP_COMFYUI_URL to the loopback server running the Qwen3-ASR graph)."
                    .into(),
            );
        }
        if !render_script_present {
            match comfy.repo() {
                Some(repo) => {
                    blockers.push(format!(
                        "the comfy pack CLI is missing at {}",
                        comfy.render_script().display()
                    ));
                    next_actions.push(format!(
                        "Clone {repo} into {} (use the Prepare workspace action).",
                        comfy.workspace().display()
                    ));
                }
                None => {
                    blockers.push(format!(
                        "the comfy pack CLI is missing at {}",
                        comfy.render_script().display()
                    ));
                    next_actions.push(
                        "Set NIP_COMFY_DIR to a comfy checkout, or NIP_COMFY_REPO to a GitHub URL so NIP can clone it."
                            .into(),
                    );
                }
            }
        } else if !workspace_present {
            blockers.push("the comfy workspace disappeared after the CLI was resolved".into());
        }
        if !python_present {
            blockers.push(format!("the Python interpreter {python} was not found"));
            next_actions.push("Install python3 or set NIP_PYTHON_BIN to its absolute path.".into());
        }
        if !ffmpeg_present {
            blockers.push("ffmpeg is not on PATH; the pack needs it to split long audio".into());
            next_actions.push("Install ffmpeg (apt install ffmpeg) and restart the app.".into());
        }
        if comfyui_url.is_some() && !server_reachable {
            blockers.push(format!(
                "ComfyUI is not reachable at {}",
                comfyui_url.as_deref().unwrap_or_default()
            ));
            next_actions
                .push("Start ComfyUI Desktop (or scripts/open_comfyui.sh) and retry.".into());
        }
        if server_reachable && !asr_nodes_present {
            blockers
                .push("ComfyUI is running but the ComfyUI-Qwen3-ASR nodes are not loaded".into());
            next_actions.push(
                "Install the ComfyUI-Qwen3-ASR custom node in ComfyUI Manager, restart ComfyUI, then retry."
                    .into(),
            );
        }
        let ready = blockers.is_empty()
            && !config.test_mode()
            && comfyui_url.is_some()
            && render_script_present;
        Self {
            ready,
            configured: comfyui_url.is_some(),
            comfyui_url,
            workspace: comfy.workspace().display().to_string(),
            workspace_present,
            render_script: comfy.render_script().display().to_string(),
            render_script_present,
            repo_url: comfy.repo().map(str::to_owned),
            chunk_seconds: comfy.chunk_seconds(),
            python,
            python_present,
            ffmpeg_present,
            server_reachable,
            server_device,
            asr_nodes_present,
            pack_commit: pack_commit(comfy.workspace()),
            blockers,
            next_actions,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ComfyWorkspaceReport {
    pub workspace: String,
    pub render_script: String,
    pub cloned: bool,
    pub commit: Option<String>,
    pub message: String,
}

/// Clone the configured pack into the workspace when it is absent.
///
/// Never overwrites a non-empty directory: a half-checkout or a user's manual
/// edits must be fixed by hand, not deleted by the app.
pub fn ensure_workspace(config: &NipConfig) -> Result<ComfyWorkspaceReport, String> {
    let comfy = config.comfy();
    let workspace = comfy.workspace().to_path_buf();
    let render_script = comfy.render_script().to_path_buf();
    if render_script.is_file() {
        return Ok(ComfyWorkspaceReport {
            workspace: workspace.display().to_string(),
            render_script: render_script.display().to_string(),
            cloned: false,
            commit: pack_commit(&workspace),
            message: "The comfy pack is already available.".into(),
        });
    }
    let repo = comfy.repo().ok_or_else(|| {
        "NIP_COMFY_REPO is not configured; set it to the comfy pack clone URL or point NIP_COMFY_DIR at an existing checkout."
            .to_owned()
    })?;
    if workspace.exists() {
        let mut entries = fs::read_dir(&workspace)
            .map_err(|error| format!("could not inspect {}: {error}", workspace.display()))?;
        if entries.next().is_some() {
            return Err(format!(
                "{} already exists but has no scripts/render.py; refusing to overwrite it. Fix NIP_COMFY_DIR or remove the directory.",
                workspace.display()
            ));
        }
    }
    let _guard = CLONE_LOCK
        .lock()
        .map_err(|_| "the workspace clone lock failed".to_owned())?;
    if render_script.is_file() {
        return Ok(ComfyWorkspaceReport {
            workspace: workspace.display().to_string(),
            render_script: render_script.display().to_string(),
            cloned: false,
            commit: pack_commit(&workspace),
            message: "The comfy pack is already available.".into(),
        });
    }
    if let Some(parent) = workspace.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    let started = Instant::now();
    let mut child = Command::new("git")
        .arg("clone")
        .arg("--depth")
        .arg("1")
        .arg("--")
        .arg(repo)
        .arg(&workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start git clone: {error}"))?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let output = child
                        .wait_with_output()
                        .map(|output| String::from_utf8_lossy(&output.stderr).trim().to_owned())
                        .unwrap_or_default();
                    return Err(format!(
                        "git clone failed ({}): {}",
                        status.code().unwrap_or(-1),
                        output.chars().take(1_500).collect::<String>()
                    ));
                }
                break;
            }
            Ok(None) if started.elapsed() > CLONE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("git clone timed out after 300s".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(250)),
            Err(error) => return Err(format!("git clone could not be monitored: {error}")),
        }
    }
    if !render_script.is_file() {
        return Err(format!(
            "the clone finished but {} is missing; check the repository layout",
            render_script.display()
        ));
    }
    let commit = pack_commit(&workspace);
    eprintln!(
        "{}",
        json!({
            "event": "nip_comfy_workspace_cloned",
            "workspace": workspace.display().to_string(),
            "commit": commit
        })
    );
    Ok(ComfyWorkspaceReport {
        workspace: workspace.display().to_string(),
        render_script: render_script.display().to_string(),
        cloned: true,
        commit,
        message: "Cloned the comfy pack. Local ASR is ready once ComfyUI is reachable.".into(),
    })
}

fn binary_available(binary: &str, args: &[&str]) -> bool {
    Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn pack_commit(workspace: &Path) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .arg("rev-parse")
        .arg("--short")
        .arg("HEAD")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let commit = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!commit.is_empty()).then_some(commit)
}

fn probe_server(server: &str) -> (bool, Option<String>, bool) {
    let agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(PROBE_TIMEOUT))
        .build();
    let agent: ureq::Agent = agent.into();
    let stats = agent.get(&format!("{server}/system_stats")).call();
    let Ok(mut stats) = stats else {
        return (false, None, false);
    };
    if stats.status().as_u16() >= 300 {
        return (false, None, false);
    }
    let body = stats.body_mut().read_to_string().unwrap_or_default();
    let device = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("devices")
                .and_then(|devices| devices.get(0))
                .and_then(|device| device.get("name"))
                .and_then(|name| name.as_str())
                .map(str::to_owned)
        });
    let nodes = agent
        .get(&format!("{server}/object_info/Qwen3ASRLoader"))
        .call()
        .ok()
        .map(|mut response| {
            response.status().as_u16() < 300
                && response
                    .body_mut()
                    .read_to_string()
                    .map(|body| body.contains("Qwen3ASRLoader"))
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    (true, device, nodes)
}
