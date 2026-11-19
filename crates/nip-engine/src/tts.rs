//! Local Qwen3-TTS narration through the independent `comfy` workflow pack.
//!
//! The Video renderer owns the slide timeline; this module only turns a scene's
//! narration text into an audio file by invoking `scripts/render.py tts`. It
//! never leaves the loopback ComfyUI endpoint and reports every missing
//! dependency as a blocker so the UI can explain why narration is unavailable.

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::config::NipConfig;

const PROBE_TIMEOUT: Duration = Duration::from_millis(2_500);
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const DEFAULT_SYNTHESIS_TIMEOUT_SECONDS: u64 = 900;

/// Everything the UI needs to explain whether local narration can run.
#[derive(Debug, Clone, Serialize)]
pub struct ComfyTtsStatus {
    pub ready: bool,
    pub render_script: String,
    pub render_script_present: bool,
    pub comfyui_url: Option<String>,
    pub server_reachable: bool,
    pub nodes_present: bool,
    pub python: String,
    pub python_present: bool,
    pub ffmpeg_present: bool,
    pub blockers: Vec<String>,
    pub next_actions: Vec<String>,
}

impl ComfyTtsStatus {
    pub fn collect(config: &NipConfig) -> Self {
        let comfy = config.comfy();
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
        let (server_reachable, nodes_present) = match comfyui_url.as_deref() {
            Some(url) => probe_server(url),
            None => (false, false),
        };
        let mut blockers = Vec::new();
        let mut next_actions = Vec::new();
        if !render_script_present {
            blockers.push(format!(
                "the comfy pack CLI is missing at {}",
                comfy.render_script().display()
            ));
            next_actions.push(
                "Set NIP_COMFY_DIR or NIP_COMFY_RENDER to a comfy checkout, then retry.".into(),
            );
        }
        if comfyui_url.is_none() {
            blockers.push(
                "no loopback ComfyUI endpoint could be resolved; narration never leaves this machine."
                    .into(),
            );
            next_actions.push(
                "Start ComfyUI Desktop (or set NIP_COMFYUI_URL to the loopback server).".into(),
            );
        }
        if !python_present {
            blockers.push(format!("the Python interpreter {python} was not found"));
            next_actions.push("Install python3 or set NIP_PYTHON_BIN to its absolute path.".into());
        }
        if !ffmpeg_present {
            blockers.push("ffmpeg is not on PATH; it is needed to fit and mux narration".into());
            next_actions.push("Install ffmpeg and restart the app.".into());
        }
        if comfyui_url.is_some() && !server_reachable {
            blockers.push(format!(
                "ComfyUI is not reachable at {}",
                comfyui_url.as_deref().unwrap_or_default()
            ));
            next_actions.push("Start ComfyUI Desktop and retry.".into());
        }
        if server_reachable && !nodes_present {
            blockers.push(
                "ComfyUI is running but the ComfyUI-Qwen3-TTS nodes (Qwen3Loader/Qwen3CustomVoice) are not loaded"
                    .into(),
            );
            next_actions.push(
                "Install the ComfyUI-Qwen3-TTS custom node pack in ComfyUI Manager, restart ComfyUI, then retry."
                    .into(),
            );
        }
        let ready = blockers.is_empty();
        Self {
            ready,
            render_script: comfy.render_script().display().to_string(),
            render_script_present,
            comfyui_url,
            server_reachable,
            nodes_present,
            python,
            python_present,
            ffmpeg_present,
            blockers,
            next_actions,
        }
    }
}

/// Synthesize one narration line to `output`. Long lines are split into
/// sentence-sized chunks: the MPS fp32 path can otherwise enter a very long
/// generation loop, and short claims also produce more stable prosody.
pub fn synthesize(
    config: &NipConfig,
    text: &str,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("narration text was empty".into());
    }
    let chunks = narration_chunks(text, 180);
    if chunks.len() <= 1 {
        return synthesize_chunk(config, text, output, cancel);
    }
    let stem = output
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("narration");
    let mut parts = Vec::with_capacity(chunks.len());
    for (index, chunk) in chunks.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err("narration synthesis was cancelled".into());
        }
        let part = output.with_file_name(format!("{stem}-part-{:02}.flac", index + 1));
        synthesize_chunk(config, chunk, &part, cancel)?;
        parts.push(part);
    }
    concat_audio(&parts, output)
}

fn synthesize_chunk(
    config: &NipConfig,
    text: &str,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("narration text was empty".into());
    }
    let render_script = config.comfy().render_script();
    if !render_script.is_file() {
        return Err(format!(
            "the comfy pack CLI is missing at {}",
            render_script.display()
        ));
    }
    let server = config
        .resolve_comfyui_url()
        .ok_or_else(|| "no loopback ComfyUI endpoint was resolved".to_owned())?;
    let python = std::env::var("NIP_PYTHON_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "python3".to_owned());
    let timeout = std::env::var("NIP_TTS_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value >= 30)
        .unwrap_or(DEFAULT_SYNTHESIS_TIMEOUT_SECONDS);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create narration directory: {error}"))?;
    }
    let log_path = output.with_extension("log");
    let stderr =
        File::create(&log_path).map_err(|error| format!("cannot create TTS log: {error}"))?;
    let language =
        std::env::var("NIP_TTS_LANGUAGE").unwrap_or_else(|_| "English".to_owned());
    let speaker = std::env::var("NIP_TTS_SPEAKER").unwrap_or_else(|_| "Ryan".to_owned());
    let max_new_tokens = ((text.chars().count() as f64) * 1.8).clamp(256.0, 768.0) as u32;
    let mut command = Command::new(&python);
    command
        .arg(render_script)
        .arg("tts")
        .arg("--prompt")
        .arg(text)
        .arg("--server")
        .arg(server.as_str())
        .arg("--output")
        .arg(output)
        .arg("--language")
        .arg(language)
        .arg("--speaker")
        .arg(speaker)
        .arg("--timeout")
        // The CLI uses wall-clock time, which can jump on host sleep/NTP. The
        // engine enforces a monotonic deadline below and kills the process.
        .arg("86400")
        .arg("--seed")
        .arg("42")
        .arg("--max-new-tokens")
        .arg(max_new_tokens.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr);
    for (key, flag) in [
        ("NIP_TTS_INSTRUCT", "--instruct"),
        ("NIP_TTS_MODEL", "--tts-model"),
    ] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                command.arg(flag).arg(value.trim());
            }
        }
    }
    // The workflow's bf16 default produces NaNs on some Apple MPS builds.
    // fp32 is the portable choice; NIP_TTS_PRECISION can opt into bf16/fp16.
    command
        .arg("--precision")
        .arg(
            std::env::var("NIP_TTS_PRECISION")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "fp32".to_owned()),
        );
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!(
                "the TTS CLI could not start: {python} {} (set NIP_PYTHON_BIN)",
                render_script.display()
            )
        } else {
            format!("the TTS CLI could not start: {error}")
        }
    })?;
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("narration synthesis was cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(status)) => {
                let detail = read_tail(&log_path, 2_000);
                return Err(format!(
                    "local Qwen3-TTS failed ({}): {}",
                    status.code().unwrap_or(-1),
                    if detail.is_empty() {
                        "the CLI returned no diagnostics".to_owned()
                    } else {
                        detail
                    }
                ));
            }
            Ok(None) if started.elapsed() > Duration::from_secs(timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("local Qwen3-TTS timed out after {timeout}s"));
            }
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("the TTS process could not be monitored: {error}"));
            }
        }
    }
    let metadata = fs::metadata(output)
        .map_err(|error| format!("local Qwen3-TTS produced no audio file: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("local Qwen3-TTS produced an empty audio file".into());
    }
    Ok(())
}

/// Split narration into sentence-sized chunks. The MPS fp32 path can enter a
/// very long generation loop on a single long paragraph, so chunks keep each
/// request bounded and aligned to punctuation.
pub fn narration_chunks(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(40);
    let mut chunks = Vec::new();
    let mut current = String::new();
    for sentence in sentences(text) {
        if sentence.chars().count() > max_chars {
            if !current.is_empty() {
                chunks.push(current.trim().to_owned());
                current.clear();
            }
            let mut piece = String::new();
            for word in sentence.split_whitespace() {
                if !piece.is_empty()
                    && piece.chars().count() + 1 + word.chars().count() > max_chars
                {
                    chunks.push(piece.trim().to_owned());
                    piece.clear();
                }
                if !piece.is_empty() {
                    piece.push(' ');
                }
                piece.push_str(word);
            }
            if !piece.trim().is_empty() {
                chunks.push(piece.trim().to_owned());
            }
            continue;
        }
        if !current.is_empty()
            && current.chars().count() + 1 + sentence.chars().count() > max_chars
        {
            chunks.push(current.trim().to_owned());
            current.clear();
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(&sentence);
    }
    if !current.trim().is_empty() {
        chunks.push(current.trim().to_owned());
    }
    chunks
}

fn sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        current.push(character);
        let boundary = matches!(character, '.' | '!' | '?' | ';');
        let followed_by_space = chars
            .peek()
            .is_none_or(|next| next.is_whitespace());
        if boundary && followed_by_space {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                sentences.push(trimmed.to_owned());
            }
            current.clear();
        }
    }
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        sentences.push(trimmed.to_owned());
    }
    sentences
}

fn concat_audio(parts: &[PathBuf], output: &Path) -> Result<(), String> {
    let list_path = output.with_extension("parts.txt");
    let mut list =
        File::create(&list_path).map_err(|error| format!("cannot create TTS part list: {error}"))?;
    for part in parts {
        let escaped = part
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "\\'");
        writeln!(list, "file '{escaped}'")
            .map_err(|error| format!("cannot write TTS part list: {error}"))?;
    }
    list.flush()
        .map_err(|error| format!("cannot flush TTS part list: {error}"))?;
    let result = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
        ])
        .arg(&list_path)
        .args(["-c:a", "flac"])
        .arg(output)
        .output()
        .map_err(|error| format!("FFmpeg TTS concat could not start: {error}"))?;
    if !result.status.success() {
        return Err(format!(
            "FFmpeg TTS concat failed: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    Ok(())
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

fn probe_server(server: &str) -> (bool, bool) {
    let agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(PROBE_TIMEOUT))
        .build();
    let agent: ureq::Agent = agent.into();
    let stats = agent.get(&format!("{server}/system_stats")).call();
    let Ok(stats) = stats else {
        return (false, false);
    };
    if stats.status().as_u16() >= 300 {
        return (false, false);
    }
    let nodes = agent
        .get(&format!("{server}/object_info/Qwen3Loader"))
        .call()
        .ok()
        .map(|mut response| {
            response.status().as_u16() < 300
                && response
                    .body_mut()
                    .read_to_string()
                    .map(|body| body.contains("Qwen3Loader"))
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    (true, nodes)
}

fn read_tail(path: &Path, limit: usize) -> String {
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let mut buffer = String::new();
    let _ = file.read_to_string(&mut buffer);
    let trimmed = buffer.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_owned();
    }
    trimmed
        .chars()
        .rev()
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// Best-effort narration text from a visual spec when the scene row is gone.
pub fn spec_narration_fallback(spec: &serde_json::Value) -> Option<String> {
    let payload = spec.get("payload")?;
    let text = match payload.get("kind").and_then(serde_json::Value::as_str)? {
        "evidence_card" => {
            let title = payload.get("title").and_then(serde_json::Value::as_str)?;
            let body = payload
                .get("body")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            Some(format!("{title}. {body}"))
        }
        "quote_card" => payload
            .get("quote")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        "kinetic_text" | "caption" => payload
            .get("text")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        "chart_transition" => payload
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        _ => payload
            .get("label")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    };
    text.map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spec_fallback_prefers_cards_and_ignores_empty_payloads() {
        assert_eq!(
            spec_narration_fallback(&json!({
                "payload": {"kind": "evidence_card", "title": "Title", "body": "Body"}
            }))
            .as_deref(),
            Some("Title. Body")
        );
        assert_eq!(
            spec_narration_fallback(&json!({"payload": {"kind": "caption", "text": "  "}})),
            None
        );
    }

    #[test]
    fn narration_is_chunked_on_sentence_and_word_boundaries() {
        let text = "First sentence. Second sentence is here! A third one?";
        assert_eq!(
            narration_chunks(text, 40),
            vec!["First sentence. Second sentence is here!", "A third one?"]
        );
        let long = "word ".repeat(30);
        let chunks = narration_chunks(long.trim(), 40);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 40));
        assert!(narration_chunks("", 40).is_empty());
    }
}
