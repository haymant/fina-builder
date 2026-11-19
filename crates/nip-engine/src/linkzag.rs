use chrono::Utc;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

#[derive(Debug, Clone)]
pub struct LinkZagOutcome {
    pub state: String,
    pub scene_checksum: String,
    pub manifest: Option<Value>,
    pub media_path: Option<PathBuf>,
    pub renderer_revision: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct LinkZagAssembly {
    pub media_path: PathBuf,
    pub media_hash: String,
    pub media_file: Value,
    pub manifest: Value,
}

struct ProjectStageDir(PathBuf);

impl Drop for ProjectStageDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn render(
    spec: &Value,
    workspace: &Path,
    media_root: &Path,
    run_id: &str,
    cancel: &AtomicBool,
) -> Result<LinkZagOutcome, String> {
    let raw_scene_id = spec
        .get("scene_id")
        .and_then(Value::as_str)
        .or_else(|| spec.get("spec_id").and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "persisted visual spec requires scene_id or spec_id".to_owned())?;
    let scene_id = safe_name(raw_scene_id);
    if scene_id.is_empty() {
        return Err("visual spec scene identifier has no safe characters".into());
    }
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
    let linkzag_root = std::env::var_os("NIP_LINKZAG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.join("modules/linkZagShow"));
    let package = linkzag_root.join("package.json");
    if !package.is_file() {
        let canonical = serde_json::to_vec(&scene).map_err(|error| error.to_string())?;
        return Ok(LinkZagOutcome {
            state: "not_configured".into(),
            scene_checksum: hex_digest(&canonical),
            manifest: None,
            media_path: None,
            renderer_revision: "not_configured".into(),
            message: format!(
                "LinkZag checkout is not available at {}",
                linkzag_root.display()
            ),
        });
    }
    let job_dir = media_root
        .join("video")
        .join("linkzag")
        .join(safe_name(run_id));
    let output_dir = job_dir.join("output");
    let managed_scene_path = job_dir.join(format!("{scene_id}.json"));
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("cannot create LinkZag output directory: {error}"))?;
    let stage_dir = linkzag_root
        .join("node_modules/.cache/fina-builder")
        .join(safe_name(run_id));
    fs::create_dir_all(&stage_dir)
        .map_err(|error| format!("cannot create LinkZag scene staging directory: {error}"))?;
    let _stage_cleanup = ProjectStageDir(stage_dir.clone());
    let scene_path = stage_dir.join(format!("{scene_id}.json"));
    let scene_source = serde_json::to_vec_pretty(&scene).map_err(|error| error.to_string())?;
    fs::write(&scene_path, &scene_source).map_err(|error| error.to_string())?;
    let checksum = linkzag_source_checksum(&scene_path, &scene_source);
    let revision = git_revision(&linkzag_root).unwrap_or_else(|| "unknown".into());
    let mut child = Command::new("npm")
        .current_dir(&linkzag_root)
        .args(["run", "segment", "--", "--scene"])
        .arg(&scene_path)
        .args(["--format", "mp4", "--out"])
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
                scene_checksum: checksum,
                manifest: None,
                media_path: None,
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
                    scene_checksum: checksum,
                    manifest: None,
                    media_path: None,
                    renderer_revision: revision,
                    message: "LinkZag segment command failed".into(),
                });
            }
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    let manifest_path = output_dir.join("segment.json");
    let mut manifest = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("LinkZag did not produce segment.json: {error}"))
        .and_then(|text| {
            serde_json::from_str::<Value>(&text)
                .map_err(|error| format!("invalid LinkZag segment.json: {error}"))
        })?;
    let resolved_checksum = manifest
        .pointer("/scene/checksum")
        .and_then(Value::as_str)
        .ok_or_else(|| "LinkZag segment manifest omitted the scene checksum".to_owned())?;
    if resolved_checksum != checksum {
        return Err(format!(
            "LinkZag scene checksum mismatch: expected {checksum}, got {resolved_checksum}"
        ));
    }
    let media_file = mp4_manifest_entry(&manifest)?.clone();
    let media_path = resolve_output_file(&media_file, &linkzag_root, &output_dir)?;
    fs::write(&managed_scene_path, &scene_source)
        .map_err(|error| format!("cannot preserve rendered scene source: {error}"))?;
    let managed_scene_relative = managed_scene_path
        .strip_prefix(media_root)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "managed scene source escaped the media root".to_owned())?;
    let scene_manifest = manifest
        .get_mut("scene")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "LinkZag manifest omitted scene metadata".to_owned())?;
    scene_manifest.insert("managed_source_path".into(), json!(managed_scene_relative));
    scene_manifest.insert(
        "canonical_source_hash".into(),
        json!(hex_digest(&scene_source)),
    );
    Ok(LinkZagOutcome {
        state: "ready".into(),
        scene_checksum: checksum,
        manifest: Some(manifest),
        media_path: Some(media_path),
        renderer_revision: revision,
        message: "Deterministic LinkZag MP4 segment verified".into(),
    })
}

pub fn assemble(
    segments: &[LinkZagOutcome],
    media_root: &Path,
    run_id: &str,
) -> Result<LinkZagAssembly, String> {
    if segments.is_empty() {
        return Err("storyboard assembly requires at least one rendered slide".into());
    }
    let output_dir = media_root
        .join("video")
        .join("linkzag")
        .join(safe_name(run_id))
        .join("assembled");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("cannot create storyboard assembly directory: {error}"))?;
    let concat_path = output_dir.join("segments.txt");
    let mut concat = File::create(&concat_path)
        .map_err(|error| format!("cannot create storyboard segment list: {error}"))?;
    for segment in segments {
        let path = segment
            .media_path
            .as_ref()
            .filter(|_| segment.state == "ready")
            .ok_or_else(|| {
                "storyboard contains a slide without a verified MP4 segment".to_owned()
            })?;
        let escaped = path
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "\\'");
        writeln!(concat, "file '{escaped}'")
            .map_err(|error| format!("cannot write storyboard segment list: {error}"))?;
    }
    concat
        .flush()
        .map_err(|error| format!("cannot flush storyboard segment list: {error}"))?;

    let output_path = output_dir.join("storyboard.mp4");
    let encoding = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
        ])
        .arg(&concat_path)
        .args([
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "30",
            "-movflags",
            "+faststart",
        ])
        .arg(&output_path)
        .output()
        .map_err(|error| format!("FFmpeg storyboard assembly could not start: {error}"))?;
    if !encoding.status.success() {
        return Err(format!(
            "FFmpeg storyboard assembly failed: {}",
            String::from_utf8_lossy(&encoding.stderr).trim()
        ));
    }
    let output = output_path
        .canonicalize()
        .map_err(|error| format!("assembled MP4 was not produced: {error}"))?;
    let metadata =
        fs::metadata(&output).map_err(|error| format!("cannot inspect assembled MP4: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("assembled MP4 is empty or is not a regular file".into());
    }
    let probe = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=format_name,duration:stream=codec_type,width,height",
            "-of",
            "json",
        ])
        .arg(&output)
        .output()
        .map_err(|error| format!("ffprobe storyboard validation could not start: {error}"))?;
    if !probe.status.success() {
        return Err(format!(
            "ffprobe rejected the assembled MP4: {}",
            String::from_utf8_lossy(&probe.stderr).trim()
        ));
    }
    let probe: Value = serde_json::from_slice(&probe.stdout)
        .map_err(|error| format!("ffprobe returned invalid storyboard metadata: {error}"))?;
    let format_name = probe
        .pointer("/format/format_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !format_name.split(',').any(|format| format == "mp4") {
        return Err("assembled media is not recognized as MP4".into());
    }
    let video = probe
        .get("streams")
        .and_then(Value::as_array)
        .and_then(|streams| {
            streams
                .iter()
                .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
        })
        .ok_or_else(|| "assembled MP4 has no video stream".to_owned())?;
    let width = video
        .get("width")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let height = video
        .get("height")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let duration = probe
        .pointer("/format/duration")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| "assembled MP4 has no valid positive duration".to_owned())?;
    let media_hash = hash_file(&output)?;
    let media_file = json!({
        "format": "mp4",
        "path": output,
        "byte_size": metadata.len(),
        "width": width,
        "height": height,
        "duration": duration
    });
    let manifest = json!({
        "format": "mp4",
        "content_hash": media_hash,
        "byte_size": metadata.len(),
        "width": width,
        "height": height,
        "duration": duration,
        "segments": segments.iter().map(|segment| segment.manifest.clone()).collect::<Vec<_>>()
    });
    Ok(LinkZagAssembly {
        media_path: output,
        media_hash,
        media_file,
        manifest,
    })
}

fn compile_scene(
    spec: &Value,
    scene_id: &str,
    duration_ms: u64,
    width: u64,
    height: u64,
) -> Result<Value, String> {
    let payload = spec
        .get("payload")
        .filter(|value| value.is_object())
        .ok_or_else(|| "persisted visual spec is missing its typed payload".to_owned())?;
    let visual_kind = payload
        .get("kind")
        .and_then(Value::as_str)
        .or_else(|| spec.get("template").and_then(Value::as_str))
        .unwrap_or("evidence_card");
    let source_id = spec
        .get("sources")
        .and_then(Value::as_array)
        .and_then(|sources| sources.first())
        .and_then(|source| source.get("source_id"))
        .and_then(Value::as_str)
        .unwrap_or("retained source");
    let (title, subtitle, item_text, item_kind) = match visual_kind {
        "evidence_card" => (
            payload
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Evidence-linked commentary"),
            payload
                .get("disclosure")
                .and_then(Value::as_str)
                .unwrap_or(source_id),
            payload
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or("Retained source evidence remains authoritative."),
            "markdown",
        ),
        "quote_card" => (
            payload
                .get("speaker")
                .and_then(Value::as_str)
                .unwrap_or("What the source says"),
            payload
                .get("source_label")
                .and_then(Value::as_str)
                .unwrap_or(source_id),
            payload
                .get("quote")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            "quote",
        ),
        "kinetic_text" | "caption" => (
            "Commentary",
            payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("Evidence-linked commentary candidate"),
            "",
            "markdown",
        ),
        "chart_transition" => (
            payload
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Evidence snapshot"),
            "Illustrative data only · verify against retained sources",
            "",
            "markdown",
        ),
        "scene_transition" => (
            "Next",
            payload
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("Continue the review"),
            "",
            "markdown",
        ),
        _ => {
            return Err(format!(
                "unsupported VideoVisualSpec payload kind: {visual_kind}"
            ))
        }
    };
    let title = safe_display_text(title, 100);
    let subtitle = safe_display_text(subtitle, 320);
    let item_text = match visual_kind {
        "evidence_card" => escape_markdown(&safe_display_multiline(item_text, 1200)),
        "quote_card" => safe_display_multiline(item_text, 360),
        _ => format!(
            "## {}\n\n{}",
            escape_markdown(&title),
            escape_markdown(&subtitle)
        ),
    };
    let horizontal_margin = (width as f64 * 0.08).round() as u64;
    let item_y = (height as f64 * 0.40).round() as u64;
    let item_height = (height as f64 * 0.48).round() as u64;
    let item_geometry = json!({
        "x":horizontal_margin,
        "y":item_y,
        "width":width.saturating_sub(horizontal_margin.saturating_mul(2)),
        "height":item_height
    });
    let item = if item_kind == "quote" {
        let mut item = item_geometry;
        item["type"] = json!(item_kind);
        item["text"] = json!(item_text);
        item
    } else {
        let mut item = item_geometry;
        item["type"] = json!(item_kind);
        item["content"] = json!(item_text);
        item
    };
    let mut items = vec![item];
    if visual_kind == "kinetic_text" || visual_kind == "caption" {
        items[0]["enter"] = json!({"type":"fade-up","delay":0.2,"duration":0.8});
    }
    Ok(json!({
        "id": scene_id,
        "duration": duration_ms as f64 / 1000.0,
        "width": width,
        "height": height,
        "theme": "dark",
        "background": "theme",
        "eyebrow": "FINA · EVIDENCE FIRST",
        "title": title,
        "subtitle": subtitle,
        "items": items
    }))
}

fn safe_display_multiline(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn mp4_manifest_entry(manifest: &Value) -> Result<&Value, String> {
    manifest
        .get("files")
        .and_then(Value::as_array)
        .and_then(|files| {
            files
                .iter()
                .find(|file| file.get("format").and_then(Value::as_str) == Some("mp4"))
        })
        .ok_or_else(|| "LinkZag manifest did not contain an MP4 output".to_owned())
}

fn resolve_output_file(
    entry: &Value,
    linkzag_root: &Path,
    output_dir: &Path,
) -> Result<PathBuf, String> {
    let raw_path = entry
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "LinkZag MP4 manifest entry omitted its path".to_owned())?;
    let raw_path = PathBuf::from(raw_path);
    let candidate = if raw_path.is_absolute() {
        raw_path
    } else {
        linkzag_root.join(raw_path)
    };
    let canonical_output = output_dir
        .canonicalize()
        .map_err(|error| format!("cannot resolve LinkZag output directory: {error}"))?;
    let canonical_file = candidate
        .canonicalize()
        .map_err(|error| format!("LinkZag MP4 output is unavailable: {error}"))?;
    if !canonical_file.starts_with(&canonical_output) {
        return Err("LinkZag MP4 path resolved outside the managed job output".into());
    }
    let metadata = fs::metadata(&canonical_file)
        .map_err(|error| format!("cannot inspect LinkZag MP4 output: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("LinkZag MP4 output is empty or is not a regular file".into());
    }
    Ok(canonical_file)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("cannot read rendered MP4: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let bytes = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot hash rendered MP4: {error}"))?;
        if bytes == 0 {
            break;
        }
        digest.update(&buffer[..bytes]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn safe_display_text(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(max_chars).collect()
}

fn escape_markdown(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| match character {
            '\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '<' | '>' | '#' | '+' | '-' | '.'
            | '!' | '|' => {
                vec!['\\', character]
            }
            _ => vec![character],
        })
        .collect()
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

fn linkzag_source_checksum(path: &Path, source: &[u8]) -> String {
    let mut checksum_input = format!("scene:{}\n", path.display()).into_bytes();
    checksum_input.extend_from_slice(source);
    hex_digest(&checksum_input)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_quote_card_compiles_from_persisted_payload() {
        let spec = json!({
            "spec_id":"spec-1",
            "template":"quote_card",
            "payload":{"kind":"quote_card","quote":"Rates remain restrictive, according to the latest review.","speaker":"Analyst","source_label":"Research note 17"},
            "sources":[{"source_id":"event-1","quote":"Rates remain restrictive."}]
        });
        let scene = compile_scene(&spec, "scene-1", 6_000, 1280, 720).unwrap();
        assert_eq!(scene["title"], "Analyst");
        assert_eq!(scene["subtitle"], "Research note 17");
        assert_eq!(scene["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            scene["items"][0]["text"],
            "Rates remain restrictive, according to the latest review."
        );
        assert_eq!(scene["items"][0]["type"], "quote");
        assert!(!scene["items"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Analyst"));
        assert!(!scene["items"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Research note 17"));
        assert_item_in_frame(&scene);
    }

    #[test]
    fn evidence_card_uses_disclosure_and_preserves_multiline_body_once() {
        let spec = json!({
            "template":"evidence_card",
            "payload":{
                "kind":"evidence_card",
                "title":"Quarterly evidence",
                "body":"First retained line\nSecond retained line",
                "disclosure":"Source: filing 2026-Q3"
            },
            "sources":[{"source_id":"filing-1","quote":"not the card body"}]
        });
        let scene = compile_scene(&spec, "scene-2", 6_000, 1280, 720).unwrap();
        assert_eq!(scene["title"], "Quarterly evidence");
        assert_eq!(scene["subtitle"], "Source: filing 2026-Q3");
        assert_eq!(scene["items"].as_array().unwrap().len(), 1);
        let content = scene["items"][0]["content"].as_str().unwrap();
        assert_eq!(content, "First retained line\nSecond retained line");
        assert!(!content.contains("Quarterly evidence"));
        assert!(!content.contains("Source: filing 2026-Q3"));
        assert!(!content.contains("not the card body"));
        assert_item_in_frame(&scene);
    }

    #[test]
    fn quote_item_bounds_are_safe_at_720p_and_1080p() {
        let spec = json!({
            "template":"quote_card",
            "payload":{
                "kind":"quote_card",
                "speaker":"Reviewer",
                "source_label":"Long source label",
                "quote":"A long quote intended to exercise the responsive content region. ".repeat(5)
            }
        });
        for (width, height) in [(1280, 720), (1920, 1080)] {
            let scene = compile_scene(&spec, "scene-bounds", 6_000, width, height).unwrap();
            assert_eq!(scene["items"].as_array().unwrap().len(), 1);
            assert_eq!(scene["items"][0]["text"].as_str().unwrap().len(), 360);
            assert_item_in_frame(&scene);
        }
    }

    fn assert_item_in_frame(scene: &Value) {
        let width = scene["width"].as_u64().unwrap();
        let height = scene["height"].as_u64().unwrap();
        for item in scene["items"].as_array().unwrap() {
            let x = item["x"].as_u64().unwrap();
            let y = item["y"].as_u64().unwrap();
            let item_width = item["width"].as_u64().unwrap();
            let item_height = item["height"].as_u64().unwrap();
            assert!(x > 0 && x + item_width <= width);
            assert!(y > 0 && y + item_height <= height);
        }
    }

    #[test]
    fn mp4_selection_does_not_assume_manifest_first_file_is_video() {
        let manifest = json!({"files":[
            {"format":"png","path":"still.png"},
            {"format":"mp4","path":"clip.mp4"}
        ]});
        assert_eq!(mp4_manifest_entry(&manifest).unwrap()["path"], "clip.mp4");
        assert!(mp4_manifest_entry(&json!({"files":[{"format":"png"}]})).is_err());
    }

    #[test]
    fn output_file_resolution_rejects_paths_outside_job_output() {
        let root = tempfile::tempdir().unwrap();
        let linkzag = root.path().join("linkzag");
        let output = linkzag.join("output");
        fs::create_dir_all(&output).unwrap();
        let valid = output.join("clip.mp4");
        fs::write(&valid, b"not empty").unwrap();
        let outside = linkzag.join("outside.mp4");
        fs::write(&outside, b"not empty").unwrap();
        assert!(
            resolve_output_file(&json!({"path": valid.to_string_lossy()}), &linkzag, &output)
                .is_ok()
        );
        assert!(resolve_output_file(
            &json!({"path": outside.to_string_lossy()}),
            &linkzag,
            &output
        )
        .is_err());
    }

    #[test]
    fn source_checksum_matches_linkzag_scene_loader_path_and_bytes() {
        let source = b"{\"id\":\"fixture\"}";
        let path = Path::new("/project/node_modules/.cache/fina-builder/fixture.json");
        let mut expected =
            b"scene:/project/node_modules/.cache/fina-builder/fixture.json\n".to_vec();
        expected.extend_from_slice(source);
        assert_eq!(linkzag_source_checksum(path, source), hex_digest(&expected));
        assert_ne!(
            linkzag_source_checksum(Path::new("/project/other.json"), source),
            linkzag_source_checksum(path, source)
        );
    }

    #[test]
    fn temporary_project_scene_directory_is_removed_on_drop() {
        let root = tempfile::tempdir().unwrap();
        let stage = root.path().join("stage");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("scene.json"), b"{}").unwrap();
        {
            let _cleanup = ProjectStageDir(stage.clone());
            assert!(stage.join("scene.json").is_file());
        }
        assert!(!stage.exists());
    }
}
