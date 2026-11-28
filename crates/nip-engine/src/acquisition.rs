//! NIP-owned acquisition initialization and worker supervision.
//!
//! The scraper is invoked as a subordinate process instead of a Rust crate:
//! its optional MCP dependency pins an incompatible `rmcp` version in the root
//! workspace. NIP owns the child lifecycle, while the worker remains the
//! executor of acquisition mechanics. Legacy scraper write tools are not
//! called here; a future typed acquisition request must be validated and
//! committed by NIP before that surface is enabled.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};

/// The acquisition sources configured in the shared lake, as observed by NIP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquisitionInventory {
    pub podcast_feed_urls: Vec<String>,
    pub site_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct InitResponse {
    site_inventory: Vec<SiteInventoryEntry>,
}

#[derive(Debug, Deserialize)]
struct SiteInventoryEntry {
    site_id: String,
    kind: String,
    feed_url: Option<String>,
}

/// Initialize the existing acquisition layout through its CLI and return its
/// configured source inventory. NIP supplies the lake path explicitly.
pub fn initialize_storage(lake_dir: &Path) -> Result<AcquisitionInventory, String> {
    let binary = std::env::var_os("FINA_SCRAPER_BIN")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            "FINA_SCRAPER_BIN was not provided to nip-engine; build/resolve the acquisition worker first".to_owned()
        })?;
    initialize_storage_with_binary(&binary, lake_dir)
}

fn initialize_storage_with_binary(
    binary: &Path,
    lake_dir: &Path,
) -> Result<AcquisitionInventory, String> {
    let output = Command::new(binary)
        .arg("init")
        .env_clear()
        .env("NIP_LAKE_DIR", lake_dir)
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .output()
        .map_err(|error| format!("could not launch acquisition initializer: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "acquisition initializer exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    let response: InitResponse = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "acquisition initializer returned invalid inventory JSON: {error}; stderr: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })?;
    let mut inventory = AcquisitionInventory {
        podcast_feed_urls: Vec::new(),
        site_ids: Vec::with_capacity(response.site_inventory.len()),
    };
    for site in response.site_inventory {
        if site.site_id.trim().is_empty()
            || site.site_id.trim() != site.site_id
            || site.site_id.chars().any(char::is_control)
        {
            return Err("acquisition initializer returned an invalid site ID".to_owned());
        }
        if site.kind == "podcast" {
            if let Some(feed_url) = site.feed_url {
                inventory.podcast_feed_urls.push(feed_url);
            }
        }
        inventory.site_ids.push(site.site_id);
    }
    Ok(inventory)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct AcquisitionWorkerStatus {
    pub state: String,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub detail: Option<String>,
}

#[derive(Debug)]
enum WorkerState {
    Starting,
    Ready,
    Exited { code: Option<i32>, detail: String },
    Stopped,
}

/// NIP-owned lifecycle for one long-running `fina-scraper mcp --transport
/// stdio` child. This type deliberately exposes no generic worker tool-call
/// method: legacy scraper acquisition writes remain outside the product API.
pub struct AcquisitionSupervisor {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    state: Mutex<WorkerState>,
    pid: u32,
}

impl AcquisitionSupervisor {
    /// Start the worker, complete the MCP handshake, and retain the child for
    /// the lifetime of the NIP service.
    pub fn start(binary: &Path, lake_dir: &Path) -> Result<Self, String> {
        let mut child = Command::new(binary)
            .args(["mcp", "--transport", "stdio"])
            .env_clear()
            .env("NIP_LAKE_DIR", lake_dir)
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("could not start acquisition worker: {error}"))?;
        let pid = child.id();
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "acquisition worker stdin unavailable".to_owned())
            .map_err(|error| {
                let _ = child.kill();
                let _ = child.wait();
                error
            })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "acquisition worker stdout unavailable".to_owned())
            .map_err(|error| {
                let _ = child.kill();
                let _ = child.wait();
                error
            })?;
        let (messages_tx, messages_rx) = mpsc::channel::<Result<Value, String>>();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        match serde_json::from_str::<Value>(&line) {
                            Ok(message) => {
                                if messages_tx.send(Ok(message)).is_err() {
                                    return;
                                }
                            }
                            Err(error) => {
                                let _ = messages_tx.send(Err(format!(
                                    "acquisition worker emitted invalid MCP JSON: {error}"
                                )));
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        let _ = messages_tx.send(Err(format!(
                            "acquisition worker stdout failed: {error}"
                        )));
                        return;
                    }
                }
            }
            let _ = messages_tx.send(Err("acquisition worker stdout closed".to_owned()));
        });

        let initialize = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "nip-engine", "version": env!("CARGO_PKG_VERSION")}
            }
        });
        if let Err(error) = write_message(&mut stdin, &initialize) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let response = messages_rx
            .recv_timeout(Duration::from_secs(20))
            .map_err(|error| format!("acquisition worker did not become ready: {error}"))??;
        if response.get("error").is_some() || response.get("result").is_none() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("acquisition worker initialize failed: {response}"));
        }
        if let Err(error) = write_message(
            &mut stdin,
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        ) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        Ok(Self {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            state: Mutex::new(WorkerState::Ready),
            pid,
        })
    }

    /// Return lifecycle state and reap an early exit if one occurred.
    pub fn status(&self) -> AcquisitionWorkerStatus {
        let mut state = self.state.lock().expect("acquisition state lock poisoned");
        if matches!(*state, WorkerState::Ready | WorkerState::Starting) {
            if let Ok(mut child) = self.child.lock() {
                if let Some(child) = child.as_mut() {
                    if let Ok(Some(exit)) = child.try_wait() {
                        *state = WorkerState::Exited {
                            code: exit.code(),
                            detail: if let Some(signal) = exit.signal_name() {
                                format!("worker exited by {signal}")
                            } else {
                                "worker exited unexpectedly".to_owned()
                            },
                        };
                    }
                }
            }
        }
        let (state_name, exit_code, detail) = match &*state {
            WorkerState::Starting => ("starting", None, None),
            WorkerState::Ready => ("ready", None, None),
            WorkerState::Exited { code, detail } => ("exited", *code, Some(detail.clone())),
            WorkerState::Stopped => ("stopped", None, None),
        };
        AcquisitionWorkerStatus {
            state: state_name.to_owned(),
            pid: (state_name == "ready").then_some(self.pid),
            exit_code,
            detail,
        }
    }

    /// Stop the worker and wait for it. Safe to call more than once.
    pub fn stop(&self) {
        if let Ok(mut state) = self.state.lock() {
            if matches!(*state, WorkerState::Stopped) {
                return;
            }
            *state = WorkerState::Stopped;
        }
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for AcquisitionSupervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

fn write_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    writeln!(stdin, "{message}")
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("could not write to acquisition worker: {error}"))
}

#[cfg(unix)]
trait ExitSignalName {
    fn signal_name(&self) -> Option<&'static str>;
}

#[cfg(unix)]
impl ExitSignalName for std::process::ExitStatus {
    fn signal_name(&self) -> Option<&'static str> {
        use std::os::unix::process::ExitStatusExt;
        self.signal().map(|signal| match signal {
            2 => "SIGINT",
            9 => "SIGKILL",
            15 => "SIGTERM",
            _ => "signal",
        })
    }
}

#[cfg(not(unix))]
trait ExitSignalName {
    fn signal_name(&self) -> Option<&'static str> {
        None
    }
}

#[cfg(not(unix))]
impl ExitSignalName for std::process::ExitStatus {}

#[cfg(all(test, unix))]
mod tests {
    use super::{initialize_storage_with_binary, AcquisitionInventory, AcquisitionSupervisor};
    use std::{fs, os::unix::fs::PermissionsExt, thread, time::Duration};
    use tempfile::tempdir;

    fn executable(root: &std::path::Path, body: &str) -> std::path::PathBuf {
        let path = root.join("fina-scraper-fixture");
        fs::write(&path, body).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
        path
    }

    #[test]
    fn subprocess_inventory_is_typed_and_only_podcast_feeds_are_collected() {
        let temp = tempdir().unwrap();
        let binary = executable(
            temp.path(),
            "#!/bin/sh\n[ \"$1\" = \"init\" ] || exit 2\n[ -n \"$NIP_LAKE_DIR\" ] || exit 3\nprintf '%s\\n' '{\"site_inventory\":[{\"site_id\":\"podcast-main\",\"kind\":\"podcast\",\"feed_url\":\"https://example.test/feed.xml\"},{\"site_id\":\"news-main\",\"kind\":\"website\",\"feed_url\":null}]}'\n",
        );
        let inventory = initialize_storage_with_binary(&binary, temp.path()).unwrap();
        assert_eq!(
            inventory,
            AcquisitionInventory {
                podcast_feed_urls: vec!["https://example.test/feed.xml".to_owned()],
                site_ids: vec!["podcast-main".to_owned(), "news-main".to_owned()],
            }
        );
    }

    #[test]
    fn worker_startup_shutdown_and_safe_reuse_are_typed() {
        let temp = tempdir().unwrap();
        let binary = executable(
            temp.path(),
            "#!/bin/sh\nif [ \"$1\" = \"mcp\" ]; then while IFS= read -r line; do case \"$line\" in *'\"id\":1'* ) printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"fixture\"}}}' ;; esac; done; else exit 2; fi\n",
        );
        let worker = AcquisitionSupervisor::start(&binary, temp.path()).unwrap();
        assert_eq!(worker.status().state, "ready");
        worker.stop();
        assert_eq!(worker.status().state, "stopped");
        let worker_again = AcquisitionSupervisor::start(&binary, temp.path()).unwrap();
        assert_eq!(worker_again.status().state, "ready");
    }

    #[test]
    fn worker_early_exit_is_reported() {
        let temp = tempdir().unwrap();
        let binary = executable(
            temp.path(),
            "#!/bin/sh\nif [ \"$1\" = \"mcp\" ]; then read line; printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}'; exit 7; else exit 2; fi\n",
        );
        let worker = AcquisitionSupervisor::start(&binary, temp.path()).unwrap();
        thread::sleep(Duration::from_millis(50));
        let status = worker.status();
        assert_eq!(status.state, "exited");
        assert_eq!(status.exit_code, Some(7));
    }
}
