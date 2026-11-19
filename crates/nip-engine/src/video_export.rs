//! Isolated, reusable primitives for a future managed video-export worker.
//!
//! This module intentionally does not create jobs, persist manifests, register
//! assets, or publish outputs. Callers must supply the managed media root and
//! perform their own preflight, job lifecycle, atomic registration, and cleanup.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rational {
    pub numerator: u32,
    pub denominator: u32,
}

impl Rational {
    pub fn new(numerator: u32, denominator: u32) -> Result<Self, ExportError> {
        if numerator == 0 || denominator == 0 {
            return Err(ExportError::InvalidProfile(
                "rational values must be positive".into(),
            ));
        }
        Ok(Self {
            numerator,
            denominator,
        })
    }

    fn equivalent(self, other: Self) -> bool {
        u64::from(self.numerator) * u64::from(other.denominator)
            == u64::from(other.numerator) * u64::from(self.denominator)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportContainer {
    Mp4,
    Matroska,
}

impl ExportContainer {
    fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Matroska => "mkv",
        }
    }

    fn ffmpeg_format(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Matroska => "matroska",
        }
    }

    fn accepts_probe_name(self, value: &str) -> bool {
        let names = value.split(',').map(str::trim);
        match self {
            Self::Mp4 => names
                .into_iter()
                .any(|name| matches!(name, "mp4" | "mov" | "m4a" | "3gp" | "3g2" | "mj2")),
            Self::Matroska => names
                .into_iter()
                .any(|name| matches!(name, "matroska" | "webm")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
}

impl VideoCodec {
    fn ffmpeg_name(self) -> &'static str {
        match self {
            Self::H264 => "libx264",
        }
    }

    fn probe_name(self) -> &'static str {
        match self {
            Self::H264 => "h264",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioPolicy {
    /// Preserve an audio stream if one exists; an absent stream is allowed.
    OptionalAac,
    /// Require an input audio stream and encode it as AAC.
    RequiredAac,
    /// Do not include audio in the output.
    Silent,
}

/// A constrained output profile. All command-affecting values are enums or
/// validated numeric fields; arbitrary FFmpeg flags and filter strings are not
/// accepted here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportProfile {
    pub id: String,
    pub container: ExportContainer,
    pub video_codec: VideoCodec,
    pub width: u32,
    pub height: u32,
    pub frame_rate: Rational,
    pub audio: AudioPolicy,
    pub crf: u8,
    pub preset: H264Preset,
    pub max_duration_ms: Option<u64>,
}

impl ExportProfile {
    pub fn validate(&self) -> Result<(), ExportError> {
        if !is_safe_component(&self.id) {
            return Err(ExportError::InvalidProfile(
                "profile id must be a safe identifier".into(),
            ));
        }
        if self.width == 0 || self.height == 0 || self.width % 2 != 0 || self.height % 2 != 0 {
            return Err(ExportError::InvalidProfile(
                "H.264 yuv420p output dimensions must be positive even numbers".into(),
            ));
        }
        if self.frame_rate.numerator == 0 || self.frame_rate.denominator == 0 {
            return Err(ExportError::InvalidProfile(
                "frame rate numerator and denominator must be positive".into(),
            ));
        }
        if self.crf > 51 {
            return Err(ExportError::InvalidProfile(
                "H.264 CRF must be between 0 and 51".into(),
            ));
        }
        if self.max_duration_ms == Some(0) {
            return Err(ExportError::InvalidProfile(
                "maximum duration must be positive when specified".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum H264Preset {
    Ultrafast,
    Fast,
    Medium,
    Slow,
}

impl H264Preset {
    fn ffmpeg_name(self) -> &'static str {
        match self {
            Self::Ultrafast => "ultrafast",
            Self::Fast => "fast",
            Self::Medium => "medium",
            Self::Slow => "slow",
        }
    }
}

/// Input path is always relative to the explicitly supplied managed media root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportInput {
    pub relative_path: PathBuf,
}

impl ExportInput {
    pub fn new(relative_path: impl Into<PathBuf>) -> Self {
        Self {
            relative_path: relative_path.into(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ExportError {
    #[error("invalid export profile: {0}")]
    InvalidProfile(String),
    #[error("rejected managed media path: {0}")]
    PathRejected(String),
    #[error("managed media I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("invalid ffprobe JSON: {0}")]
    InvalidProbe(String),
    #[error("ffprobe output does not match profile: {0}")]
    ProbeMismatch(String),
}

/// Resolve an existing regular media file, rejecting absolute paths, traversal,
/// non-normal path components, and canonical paths outside `managed_root`.
pub fn resolve_managed_input(
    managed_root: &Path,
    input: &ExportInput,
) -> Result<PathBuf, ExportError> {
    let relative = &input.relative_path;
    validate_relative_path(relative)?;
    let root = fs::canonicalize(managed_root).map_err(|error| {
        ExportError::PathRejected(format!("managed root is unavailable: {error}"))
    })?;
    let candidate = root.join(relative);
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| ExportError::PathRejected(format!("input is unavailable: {error}")))?;
    if !canonical.starts_with(&root) {
        return Err(ExportError::PathRejected(
            "input resolves outside the managed media root".into(),
        ));
    }
    let metadata = fs::metadata(&canonical)?;
    if !metadata.is_file() {
        return Err(ExportError::PathRejected(
            "input is not a regular file".into(),
        ));
    }
    Ok(canonical)
}

/// Create a job-scoped temporary output location under the managed root. This
/// creates only the staging directories and an output pathname, not an export
/// job or manifest. Existing symlinks in the staging hierarchy are rejected.
pub fn prepare_temp_output_path(
    managed_root: &Path,
    job_id: &str,
    profile: &ExportProfile,
) -> Result<PathBuf, ExportError> {
    profile.validate()?;
    if !is_safe_component(job_id) {
        return Err(ExportError::PathRejected(
            "job id must contain only ASCII letters, digits, '-' or '_'".into(),
        ));
    }
    let root = fs::canonicalize(managed_root).map_err(|error| {
        ExportError::PathRejected(format!("managed root is unavailable: {error}"))
    })?;
    let staging = ensure_child_directory(&root, "video-export-staging")?;
    let job_dir = ensure_child_directory(&staging, job_id)?;
    let output = job_dir.join(format!("export.tmp.{}", profile.container.extension()));
    match fs::symlink_metadata(&output) {
        Ok(_) => {
            return Err(ExportError::PathRejected(
                "temporary output path already exists".into(),
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(output)
}

/// Build a direct FFmpeg process invocation. No shell or shell-quoted command
/// string is constructed; every path and option is a separate argv element.
/// The output must be a not-yet-existing file beneath `managed_root`, and its
/// parent directory must already exist.
pub fn build_ffmpeg_command(
    ffmpeg_binary: impl AsRef<OsStr>,
    managed_root: &Path,
    input: &ExportInput,
    output_relative_path: &Path,
    profile: &ExportProfile,
) -> Result<Command, ExportError> {
    profile.validate()?;
    let input_path = resolve_managed_input(managed_root, input)?;
    let output_path = resolve_managed_output(managed_root, output_relative_path)?;
    let mut command = Command::new(ffmpeg_binary);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-y")
        .arg("-i")
        .arg(input_path)
        .arg("-map")
        .arg("0:v:0");

    match profile.audio {
        AudioPolicy::OptionalAac => {
            command.arg("-map").arg("0:a:0?").arg("-c:a").arg("aac");
        }
        AudioPolicy::RequiredAac => {
            command.arg("-map").arg("0:a:0").arg("-c:a").arg("aac");
        }
        AudioPolicy::Silent => {
            command.arg("-an");
        }
    }

    let frame_rate = format!(
        "{}/{}",
        profile.frame_rate.numerator, profile.frame_rate.denominator
    );
    let scale_pad = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2",
        profile.width, profile.height, profile.width, profile.height
    );
    command
        .arg("-c:v")
        .arg(profile.video_codec.ffmpeg_name())
        .arg("-preset")
        .arg(profile.preset.ffmpeg_name())
        .arg("-crf")
        .arg(profile.crf.to_string())
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-vf")
        .arg(scale_pad)
        .arg("-r")
        .arg(frame_rate)
        .arg("-f")
        .arg(profile.container.ffmpeg_format());
    if profile.container == ExportContainer::Mp4 {
        command.arg("-movflags").arg("+faststart");
    }
    command.arg(output_path);
    Ok(command)
}

fn resolve_managed_output(root: &Path, relative: &Path) -> Result<PathBuf, ExportError> {
    validate_relative_path(relative)?;
    let canonical_root = fs::canonicalize(root).map_err(|error| {
        ExportError::PathRejected(format!("managed root is unavailable: {error}"))
    })?;
    let file_name = relative.file_name().ok_or_else(|| {
        ExportError::PathRejected("output must name a file beneath the managed root".into())
    })?;
    let parent_relative = relative.parent().unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(canonical_root.join(parent_relative)).map_err(|error| {
        ExportError::PathRejected(format!("output directory is unavailable: {error}"))
    })?;
    if !parent.starts_with(&canonical_root) {
        return Err(ExportError::PathRejected(
            "output directory resolves outside the managed media root".into(),
        ));
    }
    let output = parent.join(file_name);
    match fs::symlink_metadata(&output) {
        Ok(_) => {
            return Err(ExportError::PathRejected(
                "output path already exists".into(),
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(output)
}

fn validate_relative_path(path: &Path) -> Result<(), ExportError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(ExportError::PathRejected(
            "path must be non-empty and relative".into(),
        ));
    }
    let mut saw_component = false;
    for component in path.components() {
        match component {
            Component::Normal(value) if value != OsStr::new("") => saw_component = true,
            _ => {
                return Err(ExportError::PathRejected(
                    "path contains a non-normal component".into(),
                ));
            }
        }
    }
    if !saw_component {
        return Err(ExportError::PathRejected("path is empty".into()));
    }
    Ok(())
}

fn is_safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn ensure_child_directory(parent: &Path, name: &str) -> Result<PathBuf, ExportError> {
    let child = parent.join(name);
    match fs::symlink_metadata(&child) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(ExportError::PathRejected(
                "staging path contains a symlink or non-directory".into(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir(&child)?,
        Err(error) => return Err(error.into()),
    }
    let canonical = fs::canonicalize(&child)?;
    if !canonical.starts_with(parent) {
        return Err(ExportError::PathRejected(
            "staging directory resolves outside the managed media root".into(),
        ));
    }
    Ok(canonical)
}

/// Parsed fields relevant to export conformance checks.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeOutput {
    pub container_names: String,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub width: u32,
    pub height: u32,
    pub frame_rate: Rational,
    pub duration_seconds: f64,
    pub byte_size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct FfprobeDocument {
    streams: Vec<FfprobeStream>,
    format: FfprobeFormat,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: String,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    format_name: String,
    duration: String,
    size: Option<String>,
}

/// Parse the JSON response from `ffprobe -show_format -show_streams -of json`.
pub fn parse_ffprobe_output(bytes: &[u8]) -> Result<ProbeOutput, ExportError> {
    let document: FfprobeDocument = serde_json::from_slice(bytes)
        .map_err(|error| ExportError::InvalidProbe(error.to_string()))?;
    let video = document
        .streams
        .iter()
        .find(|stream| stream.codec_type == "video")
        .ok_or_else(|| ExportError::InvalidProbe("no video stream".into()))?;
    let codec = video
        .codec_name
        .clone()
        .ok_or_else(|| ExportError::InvalidProbe("video stream has no codec_name".into()))?;
    let width = video
        .width
        .filter(|value| *value > 0)
        .ok_or_else(|| ExportError::InvalidProbe("video stream has invalid width".into()))?;
    let height = video
        .height
        .filter(|value| *value > 0)
        .ok_or_else(|| ExportError::InvalidProbe("video stream has invalid height".into()))?;
    let frame_rate = video
        .avg_frame_rate
        .as_deref()
        .and_then(parse_probe_rational)
        .or_else(|| video.r_frame_rate.as_deref().and_then(parse_probe_rational))
        .ok_or_else(|| ExportError::InvalidProbe("video stream has invalid frame rate".into()))?;
    let duration_seconds = document
        .format
        .duration
        .parse::<f64>()
        .ok()
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| ExportError::InvalidProbe("format has invalid duration".into()))?;
    let audio_codec = document
        .streams
        .iter()
        .find(|stream| stream.codec_type == "audio")
        .and_then(|stream| stream.codec_name.clone());
    let byte_size = document
        .format
        .size
        .as_deref()
        .and_then(|size| size.parse::<u64>().ok());
    Ok(ProbeOutput {
        container_names: document.format.format_name,
        video_codec: codec,
        audio_codec,
        width,
        height,
        frame_rate,
        duration_seconds,
        byte_size,
    })
}

fn parse_probe_rational(value: &str) -> Option<Rational> {
    let (numerator, denominator) = value.split_once('/')?;
    let numerator = numerator.parse::<u32>().ok()?;
    let denominator = denominator.parse::<u32>().ok()?;
    if numerator == 0 || denominator == 0 {
        return None;
    }
    Some(Rational {
        numerator,
        denominator,
    })
}

/// Reject a successfully parsed probe when the output does not meet its profile.
pub fn validate_probe(probe: &ProbeOutput, profile: &ExportProfile) -> Result<(), ExportError> {
    profile.validate()?;
    let mismatch = if !profile.container.accepts_probe_name(&probe.container_names) {
        Some("container")
    } else if probe.video_codec != profile.video_codec.probe_name() {
        Some("video codec")
    } else if probe.width != profile.width || probe.height != profile.height {
        Some("dimensions")
    } else if !probe.frame_rate.equivalent(profile.frame_rate) {
        Some("frame rate")
    } else if match profile.audio {
        AudioPolicy::OptionalAac => probe
            .audio_codec
            .as_deref()
            .is_some_and(|codec| codec != "aac"),
        AudioPolicy::RequiredAac => probe.audio_codec.as_deref() != Some("aac"),
        AudioPolicy::Silent => probe.audio_codec.is_some(),
    } {
        Some("unexpected audio stream")
    } else if profile
        .max_duration_ms
        .is_some_and(|maximum| probe.duration_seconds * 1000.0 > maximum as f64)
    {
        Some("maximum duration")
    } else {
        None
    };
    if let Some(field) = mismatch {
        return Err(ExportError::ProbeMismatch(field.into()));
    }
    Ok(())
}

/// Stream a file through SHA-256 and return the manifest-style `sha256:<hex>`.
pub fn sha256_file(path: &Path) -> Result<String, ExportError> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(ExportError::PathRejected(
            "hash target is not a regular file".into(),
        ));
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let hex = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("sha256:{hex}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn profile() -> ExportProfile {
        ExportProfile {
            id: "mp4-preview-v1".into(),
            container: ExportContainer::Mp4,
            video_codec: VideoCodec::H264,
            width: 1280,
            height: 720,
            frame_rate: Rational::new(30, 1).unwrap(),
            audio: AudioPolicy::OptionalAac,
            crf: 23,
            preset: H264Preset::Fast,
            max_duration_ms: Some(60_000),
        }
    }

    fn valid_probe_json() -> &'static [u8] {
        br#"{
          "streams": [
            {"codec_type":"video","codec_name":"h264","width":1280,"height":720,"avg_frame_rate":"30/1","r_frame_rate":"30/1"},
            {"codec_type":"audio","codec_name":"aac"}
          ],
          "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"12.5","size":"98765"}
        }"#
    }

    #[test]
    fn argv_keeps_metacharacter_path_as_a_single_argument() {
        let temp = tempdir().unwrap();
        fs::create_dir(temp.path().join("inputs")).unwrap();
        fs::create_dir(temp.path().join("out")).unwrap();
        let file_name = "clip ' ; $() [x].mp4";
        fs::write(temp.path().join("inputs").join(file_name), b"input").unwrap();
        let command = build_ffmpeg_command(
            "ffmpeg",
            temp.path(),
            &ExportInput::new(PathBuf::from("inputs").join(file_name)),
            Path::new("out/result.mp4"),
            &profile(),
        )
        .unwrap();
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let input_path = fs::canonicalize(temp.path().join("inputs").join(file_name))
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(args.iter().filter(|arg| *arg == &input_path).count(), 1);
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-i" && pair[1] == input_path));
        assert!(args.iter().any(|arg| arg == "0:a:0?"));
        assert_eq!(command.get_program().to_string_lossy(), "ffmpeg");
    }

    #[test]
    fn rejects_traversal_and_absolute_input_paths() {
        let temp = tempdir().unwrap();
        let traversal = ExportInput::new("../outside.mp4");
        assert!(matches!(
            resolve_managed_input(temp.path(), &traversal),
            Err(ExportError::PathRejected(_))
        ));
        let absolute = ExportInput::new(temp.path().join("outside.mp4"));
        assert!(matches!(
            resolve_managed_input(temp.path(), &absolute),
            Err(ExportError::PathRejected(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_input_symlink_escape() {
        use std::os::unix::fs::symlink;
        let temp = tempdir().unwrap();
        let root = temp.path().join("media");
        fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside.mp4");
        fs::write(&outside, b"outside").unwrap();
        symlink(&outside, root.join("escape.mp4")).unwrap();
        assert!(matches!(
            resolve_managed_input(&root, &ExportInput::new("escape.mp4")),
            Err(ExportError::PathRejected(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_output_parent_symlink_escape() {
        use std::os::unix::fs::symlink;
        let temp = tempdir().unwrap();
        let root = temp.path().join("media");
        fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("out")).unwrap();
        assert!(matches!(
            resolve_managed_output(&root, Path::new("out/video.mp4")),
            Err(ExportError::PathRejected(_))
        ));
    }

    #[test]
    fn parses_and_validates_probe_and_detects_profile_mismatch() {
        let probe = parse_ffprobe_output(valid_probe_json()).unwrap();
        assert_eq!(probe.byte_size, Some(98_765));
        validate_probe(&probe, &profile()).unwrap();
        let mut wrong = profile();
        wrong.width = 1920;
        assert!(matches!(
            validate_probe(&probe, &wrong),
            Err(ExportError::ProbeMismatch(field)) if field == "dimensions"
        ));
    }

    #[test]
    fn hashes_output_bytes_with_manifest_prefix() {
        let temp = tempdir().unwrap();
        let output = temp.path().join("output.mp4");
        fs::write(&output, b"abc").unwrap();
        assert_eq!(
            sha256_file(&output).unwrap(),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn temporary_output_path_uses_safe_job_identifier() {
        let temp = tempdir().unwrap();
        let path = prepare_temp_output_path(temp.path(), "job_123-try2", &profile()).unwrap();
        assert!(path.starts_with(temp.path()));
        assert_eq!(path.file_name().unwrap(), "export.tmp.mp4");
        assert!(matches!(
            prepare_temp_output_path(temp.path(), "../escape", &profile()),
            Err(ExportError::PathRejected(_))
        ));
    }
}
