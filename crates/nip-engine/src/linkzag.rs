use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

#[derive(Debug, Clone)]
pub struct LinkZagOutcome {
    pub state: String,
    pub scene_id: String,
    pub scene_checksum: String,
    pub manifest: Option<Value>,
    pub renderer_revision: String,
    pub message: String,
}

pub fn render(
    spec: &Value,
    workspace: &Path,
    media_root: &Path,
    run_id: &str,
    cancel: &AtomicBool,
) -> Result<LinkZagOutcome, String> {
    let scene_id = required_string(spec, "scene_id")?;
    let duration_ms = spec
        .get("duration_ms")
        .and_then(Value::as_u64)
        .unwrap_or(12_000)
        .clamp(1_000, 300_000);
    let width = spec
        .get("width")
        .and_then(Value::as_u64)
        .unwrap_or(1920)
        .clamp(320, 3840);
    let height = spec
        .get("height")
        .and_then(Value::as_u64)
        .unwrap_or(1080)
        .clamp(180, 2160);
    let scene = compile_scene(spec, &scene_id, duration_ms, width, height)?;
    let canonical = serde_json::to_vec(&scene).map_err(|error| error.to_string())?;
    let checksum = hex_digest(&canonical);
    let job_dir = media_root
        .join("video")
        .join("linkzag")
        .join(safe_name(run_id));
    fs::create_dir_all(&job_dir)
        .map_err(|error| format!("cannot create LinkZag job directory: {error}"))?;
    let scene_path = job_dir.join(format!("{scene_id}.json"));
    let output_dir = job_dir.join("output");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("cannot create LinkZag output directory: {error}"))?;
    fs::write(&scene_path, serde_json::to_vec_pretty(&scene).unwrap())
        .map_err(|error| error.to_string())?;

    let linkzag_root = std::env::var_os("NIP_LINKZAG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.join("modules/linkZagShow"));
    let package = linkzag_root.join("package.json");
    if !package.is_file() {
        return Ok(LinkZagOutcome {
            state: "not_configured".into(),
            scene_id,
            scene_checksum: checksum,
            manifest: None,
            renderer_revision: "not_configured".into(),
            message: format!(
                "LinkZag checkout is not available at {}",
                linkzag_root.display()
            ),
        });
    }
    let revision = git_revision(&linkzag_root).unwrap_or_else(|| "unknown".into());
    let mut child = Command::new("npm")
        .current_dir(&linkzag_root)
        .args(["run", "segment", "--", "--scene"])
        .arg(&scene_path)
        .args(["--format", "png,mp4", "--out"])
        .arg(&output_dir)
        .arg("--quiet")
        .spawn()
        .map_err(|error| format!("LinkZag process could not start: {error}"))?;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(LinkZagOutcome {
                state: "cancelled".into(),
                scene_id,
                scene_checksum: checksum,
                manifest: None,
                renderer_revision: revision,
                message: "LinkZag render cancelled".into(),
            });
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("LinkZag process wait failed: {error}"))?
        {
            if !status.success() {
                return Ok(LinkZagOutcome {
                    state: "failed".into(),
                    scene_id,
                    scene_checksum: checksum,
                    manifest: None,
                    renderer_revision: revision,
                    message: "LinkZag segment command failed".into(),
                });
            }
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let manifest_path = output_dir.join("segment.json");
    let manifest = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("LinkZag did not produce segment.json: {error}"))
        .and_then(|text| {
            serde_json::from_str::<Value>(&text)
                .map_err(|error| format!("invalid LinkZag segment.json: {error}"))
        })?;
    let resolved_checksum = manifest
        .pointer("/scene/checksum")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !resolved_checksum.is_empty() && resolved_checksum != checksum {
        return Err(format!(
            "LinkZag scene checksum mismatch: expected {checksum}, got {resolved_checksum}"
        ));
    }
    Ok(LinkZagOutcome {
        state: "ready".into(),
        scene_id,
        scene_checksum: checksum,
        manifest: Some(manifest),
        renderer_revision: revision,
        message: "Deterministic LinkZag segment verified".into(),
    })
}

fn compile_scene(
    spec: &Value,
    scene_id: &str,
    duration_ms: u64,
    width: u64,
    height: u64,
) -> Result<Value, String> {
    let title = spec
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Evidence-linked commentary");
    let subtitle = spec
        .get("subtitle")
        .and_then(Value::as_str)
        .unwrap_or("Deterministic renderer output · source evidence remains authoritative");
    let quote = spec.get("quote").and_then(Value::as_str).unwrap_or("");
    let visual_kind = spec
        .get("visual_kind")
        .and_then(Value::as_str)
        .unwrap_or("evidence_card");
    let mut items = vec![
        json!({"type":"markdown","x":96,"y":300,"width":width.saturating_sub(192),"height":420,"content":format!("## {title}\n\n{subtitle}")}),
    ];
    if !quote.is_empty() {
        items.push(json!({"type":"quote","x":120,"y":760,"width":width.saturating_sub(240),"height":180,"quote":quote}));
    }
    if visual_kind == "kinetic_text" {
        items[0]["enter"] = json!({"type":"fade-up","delay":0.2,"duration":0.8});
    }
    Ok(json!({
        "id": scene_id, "duration": duration_ms as f64 / 1000.0, "width": width, "height": height,
        "theme": "dark", "background": "theme", "eyebrow": "FINA · EVIDENCE FIRST",
        "title": title, "subtitle": subtitle, "items": items
    }))
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("visual spec requires non-empty {key}"))
}
fn safe_name(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn git_revision(root: &Path) -> Option<String> {
    let output = Command::new("git")
        .current_dir(root)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[allow(dead_code)]
fn _timestamp() -> String {
    Utc::now().to_rfc3339()
}
