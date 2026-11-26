//! Local narration: ComfyUI/Qwen3 first, then common system voices.
//!
//! The Video renderer owns the slide timeline; this module only turns a scene's
//! narration text into an audio file. The preferred engine is Qwen3-TTS through
//! the independent `comfy` workflow pack (invoking `scripts/render.py tts`,
//! never leaving the loopback ComfyUI endpoint). When that engine is
//! unavailable the chain falls back, in order, to `say` (macOS), `piper`,
//! `espeak-ng`, and `spd-say`, and finally to a silent render with the reason
//! recorded. `spd-say` cannot write audio to a file — it only plays through
//! Speech Dispatcher — so its probe always reports a blocker. The last resort
//! is honest silence, never a fake `narrated` flag.
//!
//! `NIP_TTS_ENGINE` pins one engine by id (`comfy_qwen3`, `say`, `piper`,
//! `espeak-ng`, `spd-say`); a pinned engine that is unavailable yields no
//! narration instead of silently falling through to another voice.

use std::{
    env,
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
const DEFAULT_FALLBACK_TIMEOUT_SECONDS: u64 = 300;

/// A narration voice, in chain order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtsEngine {
    ComfyQwen3,
    Say,
    Piper,
    EspeakNg,
    SpdSay,
}

impl TtsEngine {
    /// Chain order: ComfyUI/Qwen3 first, then the system voices.
    pub const CHAIN: [TtsEngine; 5] = [
        TtsEngine::ComfyQwen3,
        TtsEngine::Say,
        TtsEngine::Piper,
        TtsEngine::EspeakNg,
        TtsEngine::SpdSay,
    ];

    /// Stable id used in status JSON and the render record.
    pub fn id(self) -> &'static str {
        match self {
            TtsEngine::ComfyQwen3 => "comfy_qwen3",
            TtsEngine::Say => "say",
            TtsEngine::Piper => "piper",
            TtsEngine::EspeakNg => "espeak-ng",
            TtsEngine::SpdSay => "spd-say",
        }
    }

    /// Human-readable label for the UI.
    pub fn label(self) -> &'static str {
        match self {
            TtsEngine::ComfyQwen3 => "ComfyUI Qwen3-TTS",
            TtsEngine::Say => "macOS say",
            TtsEngine::Piper => "Piper",
            TtsEngine::EspeakNg => "espeak-ng",
            TtsEngine::SpdSay => "spd-say",
        }
    }

    /// Model name recorded on the rendered video asset.
    pub fn model_name(self) -> &'static str {
        match self {
            TtsEngine::ComfyQwen3 => "Qwen3-TTS-12Hz-0.6B-CustomVoice",
            TtsEngine::Say => "say (macOS system voice)",
            TtsEngine::Piper => "piper",
            TtsEngine::EspeakNg => "espeak-ng",
            TtsEngine::SpdSay => "spd-say",
        }
    }

    /// Provider id recorded in the narration manifest. ComfyUI keeps the
    /// historical `qwen3_tts_local` value; the system voices use their id.
    pub fn provider_id(self) -> &'static str {
        match self {
            TtsEngine::ComfyQwen3 => "qwen3_tts_local",
            other => other.id(),
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id.trim() {
            "comfy_qwen3" => Some(TtsEngine::ComfyQwen3),
            "say" => Some(TtsEngine::Say),
            "piper" => Some(TtsEngine::Piper),
            "espeak-ng" => Some(TtsEngine::EspeakNg),
            "spd-say" => Some(TtsEngine::SpdSay),
            _ => None,
        }
    }
}

/// One engine's availability probe, in chain order.
#[derive(Debug, Clone, Serialize)]
pub struct TtsEngineProbe {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub blocker: Option<String>,
}

/// Everything the UI needs to explain whether local narration can run, and
/// which voice will render it.
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
    /// Id of the engine that would render narration, if any.
    pub tts_engine: Option<String>,
    /// Human-readable fallback note, set only when a non-ComfyUI engine is
    /// selected, e.g. `espeak-ng (ComfyUI Qwen3 unavailable: ...)`.
    pub tts_fallback: Option<String>,
    /// Per-engine availability, in chain order.
    pub engines: Vec<TtsEngineProbe>,
}

impl ComfyTtsStatus {
    pub fn collect(config: &NipConfig) -> Self {
        let comfy = config.comfy();
        let render_script_present = comfy.render_script().is_file();
        let python = env::var("NIP_PYTHON_BIN")
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
        let mut comfy_blockers = Vec::new();
        let mut comfy_next_actions = Vec::new();
        if !render_script_present {
            comfy_blockers.push(format!(
                "the comfy pack CLI is missing at {}",
                comfy.render_script().display()
            ));
            comfy_next_actions.push(
                "Set NIP_COMFY_DIR or NIP_COMFY_RENDER to a comfy checkout, then retry.".into(),
            );
        }
        if comfyui_url.is_none() {
            comfy_blockers.push(
                "no loopback ComfyUI endpoint could be resolved; narration never leaves this machine."
                    .into(),
            );
            comfy_next_actions.push(
                "Start ComfyUI Desktop (or set NIP_COMFYUI_URL to the loopback server).".into(),
            );
        }
        if !python_present {
            comfy_blockers.push(format!("the Python interpreter {python} was not found"));
            comfy_next_actions
                .push("Install python3 or set NIP_PYTHON_BIN to its absolute path.".into());
        }
        if !ffmpeg_present {
            comfy_blockers
                .push("ffmpeg is not on PATH; it is needed to fit and mux narration".into());
            comfy_next_actions.push("Install ffmpeg and restart the app.".into());
        }
        if comfyui_url.is_some() && !server_reachable {
            comfy_blockers.push(format!(
                "ComfyUI is not reachable at {}",
                comfyui_url.as_deref().unwrap_or_default()
            ));
            comfy_next_actions.push("Start ComfyUI Desktop and retry.".into());
        }
        if server_reachable && !nodes_present {
            comfy_blockers.push(
                "ComfyUI is running but the ComfyUI-Qwen3-TTS nodes (Qwen3Loader/Qwen3CustomVoice) are not loaded"
                    .into(),
            );
            comfy_next_actions.push(
                "Install the ComfyUI-Qwen3-TTS custom node pack in ComfyUI Manager, restart ComfyUI, then retry."
                    .into(),
            );
        }
        let (engine, probes) = select_engine(config);
        let ready = engine.is_some();
        let tts_engine = engine.map(|value| value.id().to_owned());
        let tts_fallback = match engine {
            Some(TtsEngine::ComfyQwen3) | None => None,
            Some(selected) => Some(fallback_description(
                selected,
                comfy_blockers.first().map(String::as_str),
            )),
        };
        let mut blockers = Vec::new();
        let mut next_actions = Vec::new();
        if !ready {
            blockers = probes
                .iter()
                .filter_map(|probe| probe.blocker.clone())
                .collect();
            if let Some(unknown) = unknown_engine_override() {
                blockers.push(format!(
                    "NIP_TTS_ENGINE={unknown} names an unknown TTS engine (comfy_qwen3, say, piper, espeak-ng, spd-say)"
                ));
            }
            next_actions = comfy_next_actions;
            next_actions.push(
                "Install a fallback voice (espeak-ng on Linux, Piper with a voice model) or start ComfyUI Desktop."
                    .into(),
            );
        }
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
            tts_engine,
            tts_fallback,
            engines: probes,
        }
    }

    /// Status used when the NIP service itself cannot be read.
    pub fn unavailable(reason: &str) -> Self {
        Self {
            ready: false,
            render_script: String::new(),
            render_script_present: false,
            comfyui_url: None,
            server_reachable: false,
            nodes_present: false,
            python: String::new(),
            python_present: false,
            ffmpeg_present: false,
            blockers: vec![reason.to_owned()],
            next_actions: Vec::new(),
            tts_engine: None,
            tts_fallback: None,
            engines: Vec::new(),
        }
    }
}

/// Human-readable fallback note for a non-ComfyUI engine.
pub fn fallback_description(engine: TtsEngine, comfy_blocker: Option<&str>) -> String {
    match comfy_blocker {
        Some(reason) => format!("{} (ComfyUI Qwen3 unavailable: {})", engine.label(), reason),
        None => format!("{} (ComfyUI Qwen3 unavailable)", engine.label()),
    }
}

/// `NIP_TTS_ENGINE` pins one engine by id; `None` means "first available".
fn engine_override() -> Option<String> {
    env::var("NIP_TTS_ENGINE")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// The override value when it names no known engine.
fn unknown_engine_override() -> Option<String> {
    engine_override().filter(|value| TtsEngine::from_id(value).is_none())
}

/// Probe every engine in chain order and return the selected one plus the
/// probes, so callers can explain why narration is unavailable.
pub fn select_engine(config: &NipConfig) -> (Option<TtsEngine>, Vec<TtsEngineProbe>) {
    let probes = probe_engines(config);
    let selected = select_from_probes(&probes, engine_override().as_deref());
    (selected, probes)
}

/// Pure selection from probe results: the override pins one engine, otherwise
/// the first available engine in chain order wins.
pub fn select_from_probes(
    probes: &[TtsEngineProbe],
    override_id: Option<&str>,
) -> Option<TtsEngine> {
    if let Some(id) = override_id {
        let wanted = TtsEngine::from_id(id)?;
        return probes
            .iter()
            .find(|probe| probe.id == wanted.id())
            .filter(|probe| probe.available)
            .map(|_| wanted);
    }
    TtsEngine::CHAIN.into_iter().find(|&engine| {
        probes
            .iter()
            .any(|probe| probe.id == engine.id() && probe.available)
    })
}

fn probe_engines(config: &NipConfig) -> Vec<TtsEngineProbe> {
    let comfy = config.comfy();
    let render_script_present = comfy.render_script().is_file();
    let python = env::var("NIP_PYTHON_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "python3".to_owned());
    let python_present = binary_available(&python, &["--version"]);
    let ffmpeg_present = binary_available("ffmpeg", &["-version"]);
    let comfyui_url = config.resolve_comfyui_url();
    let (server_reachable, nodes_present) = match comfyui_url.as_ref() {
        Some(url) => probe_server(url.as_str()),
        None => (false, false),
    };
    let mut comfy_blockers = Vec::new();
    if !render_script_present {
        comfy_blockers.push(format!(
            "the comfy pack CLI is missing at {}",
            comfy.render_script().display()
        ));
    }
    if comfyui_url.is_none() {
        comfy_blockers.push(
            "no loopback ComfyUI endpoint could be resolved; narration never leaves this machine."
                .into(),
        );
    }
    if !python_present {
        comfy_blockers.push(format!("the Python interpreter {python} was not found"));
    }
    if !ffmpeg_present {
        comfy_blockers.push("ffmpeg is not on PATH; it is needed to fit and mux narration".into());
    }
    if comfyui_url.is_some() && !server_reachable {
        comfy_blockers.push(format!(
            "ComfyUI is not reachable at {}",
            comfyui_url
                .as_ref()
                .map(|url| url.as_str())
                .unwrap_or_default()
        ));
    }
    if server_reachable && !nodes_present {
        comfy_blockers.push(
            "ComfyUI is running but the ComfyUI-Qwen3-TTS nodes (Qwen3Loader/Qwen3CustomVoice) are not loaded"
                .into(),
        );
    }
    let mut probes = vec![TtsEngineProbe {
        id: TtsEngine::ComfyQwen3.id().to_owned(),
        label: TtsEngine::ComfyQwen3.label().to_owned(),
        available: comfy_blockers.is_empty(),
        blocker: if comfy_blockers.is_empty() {
            None
        } else {
            Some(comfy_blockers.join("; "))
        },
    }];
    probes.extend(probe_fallback_engines(ffmpeg_present));
    probes
}

fn probe_fallback_engines(ffmpeg_present: bool) -> Vec<TtsEngineProbe> {
    vec![
        probe_say(ffmpeg_present),
        probe_piper(ffmpeg_present),
        probe_espeak_ng(ffmpeg_present),
        probe_spd_say(),
    ]
}

fn probe_say(ffmpeg_present: bool) -> TtsEngineProbe {
    let engine = TtsEngine::Say;
    if !ffmpeg_present {
        return unavailable_probe(
            engine,
            "ffmpeg is not on PATH; it is needed to convert narration to FLAC",
        );
    }
    // `say -v ?` lists the installed macOS voices and exits 0. On Linux the
    // binary does not exist, so this probe is false there.
    if binary_available("say", &["-v", "?"]) {
        available_probe(engine)
    } else {
        unavailable_probe(engine, "say was not found on PATH (macOS only)")
    }
}

fn probe_piper(ffmpeg_present: bool) -> TtsEngineProbe {
    let engine = TtsEngine::Piper;
    if !ffmpeg_present {
        return unavailable_probe(
            engine,
            "ffmpeg is not on PATH; it is needed to convert narration to FLAC",
        );
    }
    // piper 1.8.0 has no --version flag (it exits 2); --help exits 0 and
    // proves the binary is present. Do not probe with --version: it makes
    // an installed piper look missing.
    if !binary_available("piper", &["--help"]) {
        return unavailable_probe(engine, "piper was not found on PATH");
    }
    if piper_model().is_none() {
        return unavailable_probe(
            engine,
            "piper is installed but no voice model is configured (set NIP_TTS_PIPER_MODEL to a .onnx voice)",
        );
    }
    available_probe(engine)
}

fn probe_espeak_ng(ffmpeg_present: bool) -> TtsEngineProbe {
    let engine = TtsEngine::EspeakNg;
    if !ffmpeg_present {
        return unavailable_probe(
            engine,
            "ffmpeg is not on PATH; it is needed to convert narration to FLAC",
        );
    }
    if binary_available("espeak-ng", &["--version"]) {
        available_probe(engine)
    } else {
        unavailable_probe(
            engine,
            "espeak-ng was not found on PATH (apt install espeak-ng on Ubuntu)",
        )
    }
}

fn probe_spd_say() -> TtsEngineProbe {
    let engine = TtsEngine::SpdSay;
    // spd-say has no file-output option: it only plays audio through Speech
    // Dispatcher, so it can never render a narration file. The probe reports
    // that plainly instead of pretending the engine is usable.
    if binary_available("spd-say", &["--version"]) {
        unavailable_probe(
            engine,
            "spd-say is installed but cannot write narration to a file; it only plays audio through Speech Dispatcher",
        )
    } else {
        unavailable_probe(engine, "spd-say was not found on PATH")
    }
}

fn available_probe(engine: TtsEngine) -> TtsEngineProbe {
    TtsEngineProbe {
        id: engine.id().to_owned(),
        label: engine.label().to_owned(),
        available: true,
        blocker: None,
    }
}

fn unavailable_probe(engine: TtsEngine, blocker: &str) -> TtsEngineProbe {
    TtsEngineProbe {
        id: engine.id().to_owned(),
        label: engine.label().to_owned(),
        available: false,
        blocker: Some(blocker.to_owned()),
    }
}

/// Piper voice model (`.onnx`) from `NIP_TTS_PIPER_MODEL`.
fn piper_model() -> Option<PathBuf> {
    let path = env::var("NIP_TTS_PIPER_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)?;
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// Synthesize one narration line to `output` (FLAC), returning the engine
/// that rendered it. Long lines are split into sentence-sized chunks: the MPS
/// fp32 path can otherwise enter a very long generation loop, and short claims
/// also produce more stable prosody.
pub fn synthesize(
    config: &NipConfig,
    text: &str,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<TtsEngine, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("narration text was empty".into());
    }
    let (engine, probes) = select_engine(config);
    let engine = engine.ok_or_else(|| {
        let mut reasons: Vec<String> = probes
            .iter()
            .filter_map(|probe| probe.blocker.clone())
            .collect();
        if let Some(unknown) = unknown_engine_override() {
            reasons.push(format!(
                "NIP_TTS_ENGINE={unknown} names an unknown TTS engine"
            ));
        }
        if reasons.is_empty() {
            "no TTS engine is available".to_owned()
        } else {
            format!("no TTS engine is available: {}", reasons.join("; "))
        }
    })?;
    match engine {
        TtsEngine::ComfyQwen3 => synthesize_comfy(config, text, output, cancel)?,
        other => synthesize_fallback(other, text, output, cancel)?,
    }
    Ok(engine)
}

fn synthesize_comfy(
    config: &NipConfig,
    text: &str,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
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
    let python = env::var("NIP_PYTHON_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "python3".to_owned());
    let timeout = env::var("NIP_TTS_TIMEOUT_SECONDS")
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
    let language = env::var("NIP_TTS_LANGUAGE").unwrap_or_else(|_| "English".to_owned());
    let speaker = env::var("NIP_TTS_SPEAKER").unwrap_or_else(|_| "Ryan".to_owned());
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
        if let Ok(value) = env::var(key) {
            if !value.trim().is_empty() {
                command.arg(flag).arg(value.trim());
            }
        }
    }
    // The workflow's bf16 default produces NaNs on some Apple MPS builds.
    // fp32 is the portable choice; NIP_TTS_PRECISION can opt into bf16/fp16.
    command.arg("--precision").arg(
        env::var("NIP_TTS_PRECISION")
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

/// Synthesize with a fallback engine (say/piper/espeak-ng). Each chunk is
/// rendered to a raw file, converted to FLAC with ffmpeg, and the parts are
/// concatenated exactly like the ComfyUI path, so the downstream mux sees the
/// same format.
fn synthesize_fallback(
    engine: TtsEngine,
    text: &str,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if engine == TtsEngine::SpdSay {
        return Err(
            "spd-say cannot write narration to a file; it only plays audio through Speech Dispatcher"
                .into(),
        );
    }
    if engine == TtsEngine::ComfyQwen3 {
        return Err("synthesize_fallback cannot run the ComfyUI engine".into());
    }
    let chunks = narration_chunks(text, 180);
    if chunks.len() <= 1 {
        return synthesize_fallback_chunk(engine, text, output, cancel);
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
        synthesize_fallback_chunk(engine, chunk, &part, cancel)?;
        parts.push(part);
    }
    concat_audio(&parts, output)
}

fn synthesize_fallback_chunk(
    engine: TtsEngine,
    text: &str,
    output: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("narration text was empty".into());
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create narration directory: {error}"))?;
    }
    // `say` writes AIFF; the other fallback engines write WAV. Both are
    // converted to FLAC below so the output matches the ComfyUI path.
    let raw = if engine == TtsEngine::Say {
        output.with_extension("aiff")
    } else {
        output.with_extension("wav")
    };
    run_fallback_synthesis(engine, text, &raw, cancel)?;
    let raw_metadata = fs::metadata(&raw)
        .map_err(|error| format!("{} produced no audio file: {error}", engine.label()))?;
    if !raw_metadata.is_file() || raw_metadata.len() == 0 {
        return Err(format!("{} produced an empty audio file", engine.label()));
    }
    convert_to_flac(&raw, output)?;
    let _ = fs::remove_file(&raw);
    let metadata = fs::metadata(output)
        .map_err(|error| format!("{} produced no audio file: {error}", engine.label()))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(format!("{} produced an empty audio file", engine.label()));
    }
    Ok(())
}

/// Run one fallback-engine synthesis to `raw`, honouring cancellation and a
/// per-chunk timeout. Piper reads its text on stdin; the others take it as an
/// argument.
fn run_fallback_synthesis(
    engine: TtsEngine,
    text: &str,
    raw: &Path,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let (mut command, stdin_text) = fallback_command(engine, text, raw)?;
    let timeout = env::var("NIP_TTS_FALLBACK_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value >= 30)
        .unwrap_or(DEFAULT_FALLBACK_TIMEOUT_SECONDS);
    let log_path = raw.with_extension("log");
    let stderr =
        File::create(&log_path).map_err(|error| format!("cannot create TTS log: {error}"))?;
    command
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(stderr);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!(
                "{} could not start: {} was not found on PATH",
                engine.label(),
                engine.id()
            )
        } else {
            format!("{} could not start: {error}", engine.label())
        }
    })?;
    if let Some(text) = stdin_text {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
    }
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
                    "{} failed ({}): {}",
                    engine.label(),
                    status.code().unwrap_or(-1),
                    if detail.is_empty() {
                        "the engine returned no diagnostics".to_owned()
                    } else {
                        detail
                    }
                ));
            }
            Ok(None) if started.elapsed() > Duration::from_secs(timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} timed out after {timeout}s", engine.label()));
            }
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("the TTS process could not be monitored: {error}"));
            }
        }
    }
    Ok(())
}

/// Build the engine command. Returns the command plus optional stdin text
/// (Piper reads its text on stdin; the other engines take it as an argument).
fn fallback_command(
    engine: TtsEngine,
    text: &str,
    raw: &Path,
) -> Result<(Command, Option<String>), String> {
    match engine {
        TtsEngine::Say => {
            let mut command = Command::new("say");
            if let Ok(voice) = env::var("NIP_TTS_SAY_VOICE") {
                if !voice.trim().is_empty() {
                    command.arg("-v").arg(voice.trim());
                }
            }
            let rate = env::var("NIP_TTS_SAY_RATE")
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(175);
            command
                .arg("-r")
                .arg(rate.to_string())
                .arg("-o")
                .arg(raw)
                .arg(text);
            Ok((command, None))
        }
        TtsEngine::Piper => {
            let model = piper_model().ok_or_else(|| {
                "piper voice model is not configured (set NIP_TTS_PIPER_MODEL to a .onnx voice)"
                    .to_owned()
            })?;
            let mut command = Command::new("piper");
            command
                .arg("--model")
                .arg(&model)
                .arg("--output_file")
                .arg(raw);
            if let Ok(speaker) = env::var("NIP_TTS_PIPER_SPEAKER") {
                if !speaker.trim().is_empty() {
                    command.arg("--speaker").arg(speaker.trim());
                }
            }
            Ok((command, Some(text.to_owned())))
        }
        TtsEngine::EspeakNg => {
            let voice = env::var("NIP_TTS_ESPEAK_VOICE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "en-us".to_owned());
            let speed = env::var("NIP_TTS_ESPEAK_SPEED")
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok())
                .unwrap_or(150);
            let mut command = Command::new("espeak-ng");
            command
                .arg("-v")
                .arg(voice)
                .arg("-s")
                .arg(speed.to_string())
                .arg("-w")
                .arg(raw)
                .arg(text);
            Ok((command, None))
        }
        TtsEngine::SpdSay => Err(
            "spd-say cannot write narration to a file; it only plays audio through Speech Dispatcher"
                .into(),
        ),
        TtsEngine::ComfyQwen3 => {
            Err("the ComfyUI engine is not a fallback engine".into())
        }
    }
}

fn convert_to_flac(input: &Path, output: &Path) -> Result<(), String> {
    let result = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(input)
        .args(["-c:a", "flac"])
        .arg(output)
        .output()
        .map_err(|error| format!("FFmpeg narration convert could not start: {error}"))?;
    if !result.status.success() {
        return Err(format!(
            "FFmpeg narration convert failed: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
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
                if !piece.is_empty() && piece.chars().count() + 1 + word.chars().count() > max_chars
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
        if !current.is_empty() && current.chars().count() + 1 + sentence.chars().count() > max_chars
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
        let followed_by_space = chars.peek().is_none_or(|next| next.is_whitespace());
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
    let mut list = File::create(&list_path)
        .map_err(|error| format!("cannot create TTS part list: {error}"))?;
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
    use std::collections::BTreeMap;

    fn probe(id: &str, available: bool) -> TtsEngineProbe {
        TtsEngineProbe {
            id: id.to_owned(),
            label: id.to_owned(),
            available,
            blocker: if available {
                None
            } else {
                Some("unavailable".to_owned())
            },
        }
    }

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

    #[test]
    fn fallback_selection_follows_chain_order_and_override() {
        let probes = vec![
            probe("comfy_qwen3", false),
            probe("say", true),
            probe("piper", true),
            probe("espeak-ng", true),
            probe("spd-say", false),
        ];
        assert_eq!(select_from_probes(&probes, None), Some(TtsEngine::Say));
        let none_available = vec![
            probe("comfy_qwen3", false),
            probe("say", false),
            probe("piper", false),
            probe("espeak-ng", false),
            probe("spd-say", false),
        ];
        assert_eq!(select_from_probes(&none_available, None), None);
        // An override pins one engine even when an earlier engine is available.
        assert_eq!(
            select_from_probes(&probes, Some("espeak-ng")),
            Some(TtsEngine::EspeakNg)
        );
        // An override to an unavailable engine yields no engine at all.
        assert_eq!(select_from_probes(&probes, Some("spd-say")), None);
        // An unknown override yields no engine at all.
        assert_eq!(select_from_probes(&probes, Some("bogus")), None);
        // Only the last engine available still selects it.
        let only_last = vec![
            probe("comfy_qwen3", false),
            probe("say", false),
            probe("piper", false),
            probe("espeak-ng", true),
            probe("spd-say", false),
        ];
        assert_eq!(
            select_from_probes(&only_last, None),
            Some(TtsEngine::EspeakNg)
        );
    }

    #[test]
    fn fallback_description_names_engine_and_reason() {
        assert_eq!(
            fallback_description(
                TtsEngine::EspeakNg,
                Some("ComfyUI is not reachable at http://127.0.0.1:8188")
            ),
            "espeak-ng (ComfyUI Qwen3 unavailable: ComfyUI is not reachable at http://127.0.0.1:8188)"
        );
        assert_eq!(
            fallback_description(TtsEngine::Say, None),
            "macOS say (ComfyUI Qwen3 unavailable)"
        );
    }

    #[test]
    fn status_invariants_hold_for_any_environment() {
        let temp = tempfile::tempdir().unwrap();
        let config = NipConfig::resolve(&BTreeMap::new(), temp.path(), None, true).unwrap();
        let status = ComfyTtsStatus::collect(&config);
        // `ready` means exactly one engine is selected.
        assert_eq!(status.ready, status.tts_engine.is_some());
        assert_eq!(status.engines.len(), TtsEngine::CHAIN.len());
        assert_eq!(
            status
                .engines
                .iter()
                .map(|probe| probe.id.as_str())
                .collect::<Vec<_>>(),
            TtsEngine::CHAIN
                .iter()
                .map(|engine| engine.id())
                .collect::<Vec<_>>()
        );
        if let Some(engine) = status.tts_engine.as_deref() {
            let probe = status
                .engines
                .iter()
                .find(|probe| probe.id == engine)
                .expect("selected engine must have a probe");
            assert!(probe.available);
            assert!(probe.blocker.is_none());
            assert!(status.blockers.is_empty());
            if engine != TtsEngine::ComfyQwen3.id() {
                let fallback = status.tts_fallback.expect("fallback must be named");
                // The fallback names the engine by its display label, which
                // differs from the id for piper ("Piper" vs "piper").
                let label = TtsEngine::from_id(engine)
                    .expect("selected engine must be a known engine")
                    .label();
                assert!(fallback.contains(label));
                assert!(fallback.contains("ComfyUI Qwen3 unavailable"));
            } else {
                assert!(status.tts_fallback.is_none());
            }
        } else {
            assert!(status.tts_fallback.is_none());
            assert!(!status.blockers.is_empty());
            assert!(status
                .engines
                .iter()
                .all(|probe| !probe.available && probe.blocker.is_some()));
        }
    }

    #[test]
    fn piper_probe_detects_installed_piper_when_model_configured() {
        // Regression test: piper 1.8.0 has no --version flag (exits 2), so a
        // probe using --version reports an installed piper as missing. The
        // probe must use --help. Skips when piper/ffmpeg are absent or no
        // voice model is configured in the test environment.
        if !binary_available("piper", &["--help"])
            || !binary_available("ffmpeg", &["-version"])
            || piper_model().is_none()
        {
            return;
        }
        let probe = probe_piper(true);
        assert!(probe.available, "probe blocker: {:?}", probe.blocker);
        assert!(probe.blocker.is_none());
    }

    #[test]
    fn espeak_ng_synthesizes_a_flac_clip_when_installed() {
        if !binary_available("espeak-ng", &["--version"])
            || !binary_available("ffmpeg", &["-version"])
        {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("clip.flac");
        let cancel = AtomicBool::new(false);
        synthesize_fallback(
            TtsEngine::EspeakNg,
            "NVIDIA raised fourth quarter guidance.",
            &output,
            &cancel,
        )
        .unwrap();
        let bytes = fs::read(&output).unwrap();
        assert!(!bytes.is_empty());
        assert!(bytes.starts_with(b"fLaC"));
        // The raw WAV intermediate is cleaned up.
        assert!(!temp.path().join("clip.wav").exists());
    }
}
