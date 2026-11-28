//! NIP-owned adapter for the existing acquisition storage initializer.
//!
//! The scraper is invoked as a subordinate process instead of a Rust crate:
//! its optional MCP dependency pins an incompatible `rmcp` version in the root
//! workspace. This calls only the idempotent `init` command; it never invokes
//! legacy acquisition functions that write scraper-owned outputs/state.

use serde::Deserialize;
use std::{path::Path, process::Command};

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
        .map(std::path::PathBuf::from)
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

#[cfg(all(test, unix))]
mod tests {
    use super::{initialize_storage_with_binary, AcquisitionInventory};
    use std::{fs, os::unix::fs::PermissionsExt};
    use tempfile::tempdir;

    #[test]
    fn subprocess_inventory_is_typed_and_only_podcast_feeds_are_collected() {
        let temp = tempdir().unwrap();
        let binary = temp.path().join("fina-scraper-fixture");
        let script = "#!/bin/sh\n[ \"$1\" = \"init\" ] || exit 2\n[ -n \"$NIP_LAKE_DIR\" ] || exit 3\nprintf '%s\\n' '{\"site_inventory\":[{\"site_id\":\"podcast-main\",\"kind\":\"podcast\",\"feed_url\":\"https://example.test/feed.xml\"},{\"site_id\":\"news-main\",\"kind\":\"website\",\"feed_url\":null}]}'\n";
        fs::write(&binary, script).unwrap();
        let mut permissions = fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary, permissions).unwrap();

        let inventory = initialize_storage_with_binary(&binary, temp.path()).unwrap();
        assert_eq!(
            inventory,
            AcquisitionInventory {
                podcast_feed_urls: vec!["https://example.test/feed.xml".to_owned()],
                site_ids: vec!["podcast-main".to_owned(), "news-main".to_owned()],
            }
        );
    }
}
