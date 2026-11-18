//! Resolve the loopback ComfyUI endpoint for local ASR.
//!
//! The `comfy` pack honours `COMFYUI_SERVER`, otherwise reads the port of the
//! running ComfyUI Desktop instance from its `comfy-procs` registry, and falls
//! back to 8188 (`modules/comfy/scripts/_comfy_root.sh`). NIP needs the same
//! answer because it passes `--server` to `scripts/render.py` explicitly, so a
//! single pinned `.env` value cannot work across machines.
//!
//! Resolution order: explicit configuration, the pack's `COMFYUI_SERVER`
//! override, the Desktop registry, then the documented default port. Every
//! candidate is parsed as a [`LoopbackUrl`] before it is returned, so automatic
//! discovery can never widen the local-only ASR boundary.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::asr::LoopbackUrl;

/// ComfyUI's upstream default, and the fallback the pack documents.
pub const DEFAULT_PORT: u16 = 8188;

/// Where a resolved endpoint came from, so status output can explain itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointSource {
    Configured,
    PackOverride,
    DesktopRegistry,
    Default,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedEndpoint {
    pub url: LoopbackUrl,
    pub source: EndpointSource,
}

/// Resolve the endpoint from the process environment and the local Desktop
/// registry. Called at use time, not once at startup, so starting ComfyUI after
/// the app is already open still takes effect without a restart.
pub fn from_process(configured: Option<&str>) -> Option<ResolvedEndpoint> {
    let pack_override = env::var("COMFYUI_SERVER").ok();
    resolve(configured, pack_override.as_deref(), &desktop_roots())
}

/// Pure resolver used by tests and callers that already hold their inputs.
pub fn resolve(
    configured: Option<&str>,
    pack_override: Option<&str>,
    roots: &[PathBuf],
) -> Option<ResolvedEndpoint> {
    if let Some(endpoint) = configured
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| parse(value, EndpointSource::Configured))
    {
        return Some(endpoint);
    }
    // A non-loopback COMFYUI_SERVER is ignored rather than honoured: the pack
    // would accept it, but NIP must not send audio off this host.
    if let Some(endpoint) = pack_override
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| parse(value, EndpointSource::PackOverride))
    {
        return Some(endpoint);
    }
    for port in registry_ports(roots) {
        if let Some(endpoint) = parse(
            &format!("http://127.0.0.1:{port}"),
            EndpointSource::DesktopRegistry,
        ) {
            return Some(endpoint);
        }
    }
    parse(
        &format!("http://127.0.0.1:{DEFAULT_PORT}"),
        EndpointSource::Default,
    )
}

/// Ports recorded by running ComfyUI Desktop instances, newest file first is
/// not meaningful here, so entries are sorted for deterministic results.
fn registry_ports(roots: &[PathBuf]) -> Vec<u16> {
    let mut ports = Vec::new();
    for root in roots {
        let directory = root.join("comfy-procs");
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .collect();
        files.sort();
        for file in files {
            let Ok(text) = fs::read_to_string(&file) else {
                continue;
            };
            let Some(port) = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| value.get("port").and_then(|port| port.as_u64()))
                .and_then(|port| u16::try_from(port).ok())
            else {
                continue;
            };
            if port > 0 && !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    ports
}

fn parse(value: &str, source: EndpointSource) -> Option<ResolvedEndpoint> {
    LoopbackUrl::parse(value.trim())
        .ok()
        .map(|url| ResolvedEndpoint { url, source })
}

/// ComfyUI Desktop data directories, in the same order as the pack's
/// `_comfy_data_dirs`: XDG locations on Linux, Application Support on macOS,
/// and the Electron user-data roots on Windows.
fn desktop_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(value) = env_value("COMFY_DESKTOP_DATA") {
        roots.push(PathBuf::from(value));
    }
    for name in ["Comfy Desktop", "comfyui-desktop-2"] {
        for base in platform_data_bases() {
            roots.push(base.join(name));
        }
    }
    roots
}

fn env_value(key: &str) -> Option<OsString> {
    env::var_os(key).filter(|value| !value.is_empty())
}

#[cfg(target_os = "macos")]
fn platform_data_bases() -> Vec<PathBuf> {
    env_value("HOME")
        .map(|home| vec![Path::new(&home).join("Library/Application Support")])
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn platform_data_bases() -> Vec<PathBuf> {
    ["APPDATA", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(|key| env_value(key).map(PathBuf::from))
        .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_data_bases() -> Vec<PathBuf> {
    let home = env_value("HOME");
    let fallback = |key: &str, suffix: &str| {
        env_value(key).map(PathBuf::from).or_else(|| {
            home.clone()
                .map(|home| Path::new(&home).join(suffix))
        })
    };
    vec![
        fallback("XDG_CONFIG_HOME", ".config").unwrap_or_default(),
        fallback("XDG_STATE_HOME", ".local/state").unwrap_or_default(),
        fallback("XDG_DATA_HOME", ".local/share").unwrap_or_default(),
    ]
    .into_iter()
    .filter(|path| !path.as_os_str().is_empty())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nip-comfy-discovery-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_registry(root: &Path, name: &str, body: &str) {
        let directory = root.join("comfy-procs");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(name), body).unwrap();
    }

    #[test]
    fn explicit_configuration_wins_over_discovery() {
        let root = tempdir();
        write_registry(&root, "a.json", r#"{"port": 8189}"#);
        let resolved = resolve(
            Some("http://127.0.0.1:9000"),
            Some("http://127.0.0.1:9001"),
            &[root.clone()],
        )
        .unwrap();
        assert_eq!(resolved.url.as_str(), "http://127.0.0.1:9000");
        assert_eq!(resolved.source, EndpointSource::Configured);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pack_override_beats_the_desktop_registry() {
        let root = tempdir();
        write_registry(&root, "a.json", r#"{"port": 8189}"#);
        let resolved = resolve(None, Some("http://127.0.0.1:9001"), &[root.clone()]).unwrap();
        assert_eq!(resolved.url.as_str(), "http://127.0.0.1:9001");
        assert_eq!(resolved.source, EndpointSource::PackOverride);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn remote_pack_override_is_ignored_to_keep_asr_local() {
        let root = tempdir();
        write_registry(&root, "a.json", r#"{"port": 8190}"#);
        let resolved = resolve(None, Some("http://example.com:8188"), &[root.clone()]).unwrap();
        assert_eq!(resolved.url.as_str(), "http://127.0.0.1:8190");
        assert_eq!(resolved.source, EndpointSource::DesktopRegistry);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn desktop_registry_supplies_the_running_port() {
        let first = tempdir();
        let second = tempdir();
        write_registry(&first, "a.json", r#"{"port": 0}"#);
        write_registry(&second, "b.json", r#"{"port": 8192, "installPath": "/tmp"}"#);
        let resolved = resolve(None, None, &[first.clone(), second.clone()]).unwrap();
        assert_eq!(resolved.url.as_str(), "http://127.0.0.1:8192");
        assert_eq!(resolved.source, EndpointSource::DesktopRegistry);
        let _ = fs::remove_dir_all(first);
        let _ = fs::remove_dir_all(second);
    }

    #[test]
    fn absent_registry_falls_back_to_the_documented_default() {
        let root = tempdir();
        let resolved = resolve(None, None, &[root.clone()]).unwrap();
        assert_eq!(resolved.url.as_str(), "http://127.0.0.1:8188");
        assert_eq!(resolved.source, EndpointSource::Default);
        let _ = fs::remove_dir_all(root);
    }
}
