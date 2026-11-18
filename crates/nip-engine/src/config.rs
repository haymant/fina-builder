use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::asr::LoopbackUrl;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("NIP_TEST_MODE must be set to 1/true or 0/false")]
    InvalidTestMode,
    #[error("{0} must not be empty when explicitly set")]
    EmptyPath(&'static str),
    #[error("NIP_TEST_MODE requires NIP_DATA_DIR beneath playwright/.data/nip")]
    UnsafeTestDataDirectory,
    #[error("NIP_TEST_MODE requires NIP_LAKE_DIR beneath playwright/.data")]
    UnsafeTestLakeDirectory,
    #[error("NIP_DATA_DIR must not resolve to TAC_LAKE_DIR")]
    DataDirectoryAliasesTac,
    #[error("NIP_LAKE_DIR must not resolve to TAC_LAKE_DIR")]
    LakeDirectoryAliasesTac,
    #[error("NIP_DATA_DIR and NIP_LAKE_DIR must be different directories")]
    DataDirectoryAliasesLake,
    #[error("the operating system application-data directory could not be resolved")]
    AppDataUnavailable,
    #[error("NIP_COMFYUI_URL must be an HTTP(S) loopback URL without credentials")]
    InvalidComfyUiUrl,
    #[error("NIP_COMFY_REPO must be a clone URL, an absolute path, or empty")]
    InvalidComfyRepo,
    #[error("NIP_RIGA_BRIDGE_URL must be an HTTP(S) loopback URL without credentials")]
    InvalidRigaBridgeUrl,
    #[error("NIP_RIGA_BRIDGE_TOKEN is required when NIP_RIGA_BRIDGE_URL is configured")]
    MissingRigaBridgeToken,
    #[error("NIP_RIGA_BRIDGE_TOKEN requires NIP_RIGA_BRIDGE_URL")]
    RigaBridgeTokenWithoutUrl,
}

/// Loopback provider bridge credentials. `Debug` redacts the bearer token so a
/// configuration dump can never leak the credential NIP uses to reach the host.
#[derive(Clone, PartialEq, Eq)]
pub struct RigaBridgeConfig {
    url: LoopbackUrl,
    token: String,
}

impl std::fmt::Debug for RigaBridgeConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RigaBridgeConfig")
            .field("url", &self.url.as_str())
            .field("token", &"[redacted]")
            .finish()
    }
}

impl RigaBridgeConfig {
    pub fn url(&self) -> &str {
        self.url.as_str()
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

/// The `comfy` pack is an independent workflow repository with a documented
/// CLI (`scripts/render.py`). fina-builder never embeds or re-implements those
/// workflows: it resolves the checkout, can clone it from a configured GitHub
/// URL, and runs the CLI for each chunk of an episode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComfyWorkspaceConfig {
    workspace: PathBuf,
    render_script: PathBuf,
    repo: Option<String>,
    chunk_seconds: u32,
}

impl ComfyWorkspaceConfig {
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub fn render_script(&self) -> &Path {
        &self.render_script
    }

    pub fn repo(&self) -> Option<&str> {
        self.repo.as_deref()
    }

    pub fn chunk_seconds(&self) -> u32 {
        self.chunk_seconds
    }

    /// Ready means the documented CLI is present on disk. The ComfyUI server
    /// itself is checked separately over loopback.
    pub fn ready(&self) -> bool {
        self.render_script.is_file()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NipConfig {
    data_dir: PathBuf,
    lake_dir: PathBuf,
    test_mode: bool,
    comfyui_url: Option<LoopbackUrl>,
    comfy: ComfyWorkspaceConfig,
    riga_bridge: Option<RigaBridgeConfig>,
}

impl NipConfig {
    /// Resolve the process environment without consuming or forwarding unrelated
    /// variables such as DATABASE_URL, VECTOR_DB_URL, or provider credentials.
    pub fn from_env() -> Result<Self, ConfigError> {
        let values: BTreeMap<String, String> = [
            "NIP_DATA_DIR",
            "NIP_LAKE_DIR",
            "TAC_LAKE_DIR",
            "NIP_TEST_MODE",
            "NIP_COMFYUI_URL",
            "NIP_COMFY_DIR",
            "NIP_COMFY_REPO",
            "NIP_COMFY_RENDER",
            "NIP_ASR_CHUNK_SECONDS",
            "NIP_RIGA_BRIDGE_URL",
            "NIP_RIGA_BRIDGE_TOKEN",
        ]
        .into_iter()
        .filter_map(|key| env::var(key).ok().map(|value| (key.to_owned(), value)))
        .collect();
        let repo_root = normalize_absolute(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."),
            Path::new("/"),
        );
        let app_data = platform_app_data_root();
        Self::resolve(
            &values,
            &repo_root,
            app_data.as_deref(),
            cfg!(debug_assertions),
        )
    }

    /// Pure resolver used by tests and launchers. Relative configured paths are
    /// rooted at the repository; packaged defaults are rooted at OS app data.
    pub fn resolve(
        values: &BTreeMap<String, String>,
        repo_root: &Path,
        app_data_root: Option<&Path>,
        debug_build: bool,
    ) -> Result<Self, ConfigError> {
        let repo_root = normalize_absolute(repo_root, Path::new("/"));
        let test_mode = parse_test_mode(values.get("NIP_TEST_MODE"))?;
        let comfyui_url = values
            .get("NIP_COMFYUI_URL")
            .filter(|value| !value.trim().is_empty())
            .map(|value| LoopbackUrl::parse(value).map_err(|_| ConfigError::InvalidComfyUiUrl))
            .transpose()?;
        let comfy = resolve_comfy_workspace(values, &repo_root, app_data_root.as_deref(), debug_build)?;
        let riga_bridge = resolve_riga_bridge(values)?;

        let configured_data = configured_path(values, "NIP_DATA_DIR")?;
        if test_mode && configured_data.is_none() {
            return Err(ConfigError::UnsafeTestDataDirectory);
        }
        let data_dir = if let Some(path) = configured_data {
            normalize_absolute(&path, &repo_root)
        } else if debug_build {
            repo_root.join(".nip-data")
        } else {
            app_data_root
                .map(|root| normalize_absolute(root, Path::new("/")))
                .ok_or(ConfigError::AppDataUnavailable)?
                .join("fina-builder")
                .join("NIP")
        };

        let tac_lake_dir = configured_path(values, "TAC_LAKE_DIR")?
            .map(|path| normalize_absolute(&path, &repo_root));
        if tac_lake_dir
            .as_ref()
            .is_some_and(|tac| same_resolved_path(&data_dir, tac))
        {
            return Err(ConfigError::DataDirectoryAliasesTac);
        }

        let configured_lake = configured_path(values, "NIP_LAKE_DIR")?;
        let lake_dir = if let Some(path) = configured_lake {
            normalize_absolute(&path, &repo_root)
        } else if let Some(tac) = &tac_lake_dir {
            tac.join("nip")
        } else if debug_build {
            repo_root.join(".lake/nip")
        } else {
            data_dir.join("lake")
        };

        if tac_lake_dir
            .as_ref()
            .is_some_and(|tac| same_resolved_path(&lake_dir, tac))
        {
            return Err(ConfigError::LakeDirectoryAliasesTac);
        }
        if same_resolved_path(&data_dir, &lake_dir) {
            return Err(ConfigError::DataDirectoryAliasesLake);
        }

        if test_mode {
            let allowed_data = repo_root.join("playwright/.data/nip");
            if !is_within(&data_dir, &allowed_data) {
                return Err(ConfigError::UnsafeTestDataDirectory);
            }
            let allowed_lake = repo_root.join("playwright/.data");
            if !is_within(&lake_dir, &allowed_lake) {
                return Err(ConfigError::UnsafeTestLakeDirectory);
            }
        }

        Ok(Self {
            data_dir,
            lake_dir,
            test_mode,
            comfyui_url,
            comfy,
            riga_bridge,
        })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn lake_dir(&self) -> &Path {
        &self.lake_dir
    }

    pub fn database_path(&self) -> PathBuf {
        self.data_dir.join("nip.duckdb")
    }

    pub fn test_mode(&self) -> bool {
        self.test_mode
    }

    pub fn comfyui_url(&self) -> Option<&LoopbackUrl> {
        self.comfyui_url.as_ref()
    }

    /// True when NIP can actually transcribe locally: either the deterministic
    /// test fixture or a configured loopback ComfyUI ASR server together with
    /// the documented CLI from the independent `comfy` pack.
    pub fn local_asr_available(&self) -> bool {
        self.test_mode || (self.comfyui_url.is_some() && self.comfy.ready())
    }

    /// The external `comfy` workflow pack: workspace, CLI, optional clone URL.
    pub fn comfy(&self) -> &ComfyWorkspaceConfig {
        &self.comfy
    }

    /// NIP-owned staging area for audio handed to the local ASR adapter.
    pub fn asr_staging_root(&self) -> PathBuf {
        self.data_dir.join("asr-staging")
    }

    pub fn riga_bridge(&self) -> Option<&RigaBridgeConfig> {
        self.riga_bridge.as_ref()
    }
}

fn resolve_comfy_workspace(
    values: &BTreeMap<String, String>,
    repo_root: &Path,
    app_data_root: Option<&Path>,
    debug_build: bool,
) -> Result<ComfyWorkspaceConfig, ConfigError> {
    let workspace = match configured_path(values, "NIP_COMFY_DIR")? {
        Some(path) => normalize_absolute(&path, repo_root),
        // A source checkout ships the pack beside the app; prefer it even in a
        // release build launched from that checkout. A packaged app elsewhere
        // falls back to app data (and can clone it from NIP_COMFY_REPO).
        None if debug_build
            || repo_root
                .join("modules")
                .join("comfy")
                .join("scripts")
                .join("render.py")
                .is_file() =>
        {
            repo_root.join("modules").join("comfy")
        }
        None => app_data_root
            .map(|root| normalize_absolute(root, Path::new("/")))
            .ok_or(ConfigError::AppDataUnavailable)?
            .join("fina-builder")
            .join("NIP")
            .join("comfy"),
    };
    let render_script = match configured_path(values, "NIP_COMFY_RENDER")? {
        Some(path) => normalize_absolute(&path, repo_root),
        None => workspace.join("scripts").join("render.py"),
    };
    let repo = values
        .get("NIP_COMFY_REPO")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if let Some(repo) = repo.as_deref() {
        // `git clone` is spawned without a shell; still reject option-like
        // values so a configured URL can never become a git flag.
        if repo.starts_with('-') || repo.chars().any(char::is_control) {
            return Err(ConfigError::InvalidComfyRepo);
        }
    }
    let chunk_seconds = values
        .get("NIP_ASR_CHUNK_SECONDS")
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| (10..=600).contains(value))
        .unwrap_or(crate::asr::DEFAULT_CHUNK_SECONDS);
    Ok(ComfyWorkspaceConfig {
        workspace,
        render_script,
        repo,
        chunk_seconds,
    })
}

fn resolve_riga_bridge(
    values: &BTreeMap<String, String>,
) -> Result<Option<RigaBridgeConfig>, ConfigError> {
    let url = values
        .get("NIP_RIGA_BRIDGE_URL")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let token = values
        .get("NIP_RIGA_BRIDGE_TOKEN")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    match (url, token) {
        (None, None) => Ok(None),
        (None, Some(_)) => Err(ConfigError::RigaBridgeTokenWithoutUrl),
        (Some(_), None) => Err(ConfigError::MissingRigaBridgeToken),
        (Some(url), Some(token)) => Ok(Some(RigaBridgeConfig {
            url: LoopbackUrl::parse(url).map_err(|_| ConfigError::InvalidRigaBridgeUrl)?,
            token: token.to_owned(),
        })),
    }
}

fn configured_path(
    values: &BTreeMap<String, String>,
    key: &'static str,
) -> Result<Option<PathBuf>, ConfigError> {
    match values.get(key) {
        None => Ok(None),
        Some(value) if value.trim().is_empty() => Err(ConfigError::EmptyPath(key)),
        Some(value) => Ok(Some(PathBuf::from(value))),
    }
}

fn parse_test_mode(value: Option<&String>) -> Result<bool, ConfigError> {
    match value.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        None | Some("0") | Some("false") => Ok(false),
        Some("1") | Some("true") => Ok(true),
        _ => Err(ConfigError::InvalidTestMode),
    }
}

fn normalize_absolute(path: &Path, base: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn same_resolved_path(left: &Path, right: &Path) -> bool {
    resolved_path(left) == resolved_path(right)
}

fn is_within(path: &Path, root: &Path) -> bool {
    resolved_path(path).starts_with(resolved_path(root))
}

/// Canonicalize existing ancestors too, so a symlink cannot bypass the test
/// data boundary or make NIP's lake alias TAC's root.
fn resolved_path(path: &Path) -> PathBuf {
    let normalized = normalize_absolute(path, Path::new("/"));
    let mut cursor = normalized.clone();
    let mut missing: Vec<OsString> = Vec::new();
    while !cursor.exists() {
        let Some(name) = cursor.file_name() else {
            break;
        };
        missing.push(name.to_os_string());
        if !cursor.pop() {
            break;
        }
    }
    let mut resolved = fs::canonicalize(&cursor).unwrap_or(cursor);
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    normalize_absolute(&resolved, Path::new("/"))
}

fn platform_app_data_root() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
    } else {
        env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn env(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn debug_default_is_ignored_dev_data_and_tac_gets_nip_child_lake() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let tac = root.join(".lake");
        let config = NipConfig::resolve(
            &env(&[("TAC_LAKE_DIR", tac.to_str().unwrap())]),
            root,
            None,
            true,
        )
        .unwrap();

        assert_eq!(config.data_dir(), root.join(".nip-data"));
        assert_eq!(config.lake_dir(), tac.join("nip"));
        assert_ne!(config.lake_dir(), tac);
        assert!(!config.test_mode());
    }

    #[test]
    fn debug_default_without_tac_uses_workspace_lake_nip() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let config = NipConfig::resolve(&env(&[]), root, None, true).unwrap();

        assert_eq!(config.data_dir(), root.join(".nip-data"));
        assert_eq!(config.lake_dir(), root.join(".lake/nip"));
    }

    #[test]
    fn explicit_relative_data_and_lake_paths_are_rooted_at_repository() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let config = NipConfig::resolve(
            &env(&[
                ("NIP_DATA_DIR", ".data/nip"),
                ("NIP_LAKE_DIR", ".data/exports"),
            ]),
            root,
            None,
            true,
        )
        .unwrap();

        assert_eq!(config.data_dir(), root.join(".data/nip"));
        assert_eq!(config.database_path(), root.join(".data/nip/nip.duckdb"));
        assert_eq!(config.lake_dir(), root.join(".data/exports"));
    }

    #[test]
    fn packaged_default_uses_app_data_and_no_tac_or_database_url_is_required() {
        let temp = tempdir().unwrap();
        let app_data = temp.path().join("os-data");
        let values = env(&[("DATABASE_URL", "postgres://must-not-be-read")]);
        let config = NipConfig::resolve(&values, temp.path(), Some(&app_data), false).unwrap();

        assert_eq!(config.data_dir(), app_data.join("fina-builder/NIP"));
        assert_eq!(config.lake_dir(), app_data.join("fina-builder/NIP/lake"));
        assert!(!config.test_mode());
    }

    #[test]
    fn rejects_lake_or_data_aliasing_the_tac_root() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let tac = root.join(".lake");
        let data_alias = NipConfig::resolve(
            &env(&[
                ("NIP_DATA_DIR", tac.to_str().unwrap()),
                ("TAC_LAKE_DIR", tac.to_str().unwrap()),
            ]),
            root,
            None,
            true,
        );
        assert_eq!(
            data_alias.unwrap_err(),
            ConfigError::DataDirectoryAliasesTac
        );

        let lake_alias = NipConfig::resolve(
            &env(&[
                ("NIP_LAKE_DIR", tac.to_str().unwrap()),
                ("TAC_LAKE_DIR", tac.to_str().unwrap()),
            ]),
            root,
            None,
            true,
        );
        assert_eq!(
            lake_alias.unwrap_err(),
            ConfigError::LakeDirectoryAliasesTac
        );
    }

    #[test]
    fn test_mode_requires_disposable_paths_beneath_playwright_data() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let bad = env(&[("NIP_TEST_MODE", "1"), ("NIP_DATA_DIR", ".nip-data")]);
        assert_eq!(
            NipConfig::resolve(&bad, root, None, true).unwrap_err(),
            ConfigError::UnsafeTestDataDirectory
        );

        let data = root.join("playwright/.data/nip/run-1");
        let lake = root.join("playwright/.data/nip-lake/run-1");
        let good = env(&[
            ("NIP_TEST_MODE", "1"),
            ("NIP_DATA_DIR", data.to_str().unwrap()),
            ("NIP_LAKE_DIR", lake.to_str().unwrap()),
        ]);
        let config = NipConfig::resolve(&good, root, None, true).unwrap();
        assert!(config.test_mode());
        assert!(is_within(config.data_dir(), &root.join("playwright/.data")));
        assert!(is_within(config.lake_dir(), &root.join("playwright/.data")));
    }

    #[test]
    fn refuses_an_unsafe_test_lake_and_invalid_test_mode_values() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let data = root.join("playwright/.data/nip/run-2");
        let bad_lake = env(&[
            ("NIP_TEST_MODE", "true"),
            ("NIP_DATA_DIR", data.to_str().unwrap()),
            ("NIP_LAKE_DIR", ".lake/nip"),
        ]);
        assert_eq!(
            NipConfig::resolve(&bad_lake, root, None, true).unwrap_err(),
            ConfigError::UnsafeTestLakeDirectory
        );
        assert_eq!(
            NipConfig::resolve(&env(&[("NIP_TEST_MODE", "yes")]), root, None, true).unwrap_err(),
            ConfigError::InvalidTestMode
        );
    }

    #[test]
    fn comfy_workspace_is_configurable_and_defaults_to_the_dev_checkout() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let config = NipConfig::resolve(&env(&[]), root, None, true).unwrap();
        assert_eq!(config.comfy().workspace(), root.join("modules/comfy"));
        assert_eq!(
            config.comfy().render_script(),
            root.join("modules/comfy/scripts/render.py")
        );
        assert_eq!(config.comfy().chunk_seconds(), 45);
        assert!(!config.local_asr_available());

        let custom = NipConfig::resolve(
            &env(&[
                ("NIP_COMFYUI_URL", "http://127.0.0.1:8190"),
                ("NIP_COMFY_DIR", "vendor/comfy"),
                ("NIP_ASR_CHUNK_SECONDS", "30"),
            ]),
            root,
            None,
            true,
        )
        .unwrap();
        assert_eq!(custom.comfy().workspace(), root.join("vendor/comfy"));
        assert_eq!(
            custom.comfy().render_script(),
            root.join("vendor/comfy/scripts/render.py")
        );
        assert_eq!(custom.comfy().chunk_seconds(), 30);
        // The pack is not present in this fixture, so ASR stays unavailable.
        assert!(!custom.local_asr_available());
    }

    #[test]
    fn comfy_clone_url_is_optional_and_rejects_git_flags() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let config = NipConfig::resolve(
            &env(&[("NIP_COMFY_REPO", "https://github.com/haymant/comfyui-flows.git")]),
            root,
            None,
            true,
        )
        .unwrap();
        assert_eq!(
            config.comfy().repo(),
            Some("https://github.com/haymant/comfyui-flows.git")
        );
        assert_eq!(
            NipConfig::resolve(&env(&[("NIP_COMFY_REPO", "--upload-pack=evil")]), root, None, true)
                .unwrap_err(),
            ConfigError::InvalidComfyRepo
        );
    }

    #[test]
    fn a_source_checkout_prefers_its_own_comfy_pack_even_in_release_builds() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("modules/comfy/scripts")).unwrap();
        std::fs::write(root.join("modules/comfy/scripts/render.py"), b"# cli\n").unwrap();
        let app_data = temp.path().join("os-data");
        let config = NipConfig::resolve(&env(&[]), root, Some(&app_data), false).unwrap();
        assert_eq!(config.comfy().workspace(), root.join("modules/comfy"));
        assert!(config.comfy().ready());
        assert_eq!(
            config.comfy().render_script(),
            root.join("modules/comfy/scripts/render.py")
        );
    }

    #[test]
    fn packaged_default_comfy_workspace_lives_in_app_data() {
        let temp = tempdir().unwrap();
        let app_data = temp.path().join("os-data");
        let config = NipConfig::resolve(&env(&[]), temp.path(), Some(&app_data), false).unwrap();
        assert_eq!(
            config.comfy().workspace(),
            app_data.join("fina-builder/NIP/comfy")
        );
    }

    #[test]
    fn validates_optional_loopback_comfyui_url_without_exposing_other_environment() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let config = NipConfig::resolve(
            &env(&[("NIP_COMFYUI_URL", "http://127.0.0.1:8188")]),
            root,
            None,
            true,
        )
        .unwrap();
        assert_eq!(
            config.comfyui_url().unwrap().as_str(),
            "http://127.0.0.1:8188"
        );
        assert_eq!(
            NipConfig::resolve(
                &env(&[("NIP_COMFYUI_URL", "http://example.com:8188")]),
                root,
                None,
                true,
            )
            .unwrap_err(),
            ConfigError::InvalidComfyUiUrl
        );
    }

    #[test]
    fn validates_riga_bridge_url_and_token_as_one_binding_without_leaking_the_token() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let config = NipConfig::resolve(
            &env(&[
                ("NIP_RIGA_BRIDGE_URL", "http://127.0.0.1:49152"),
                ("NIP_RIGA_BRIDGE_TOKEN", "fixture-bearer-token"),
            ]),
            root,
            None,
            true,
        )
        .unwrap();
        let bridge = config.riga_bridge().unwrap();
        assert_eq!(bridge.url(), "http://127.0.0.1:49152");
        assert_eq!(bridge.token(), "fixture-bearer-token");
        let debug = format!("{bridge:?}");
        assert!(debug.contains("http://127.0.0.1:49152"));
        assert!(!debug.contains("fixture-bearer-token"));

        assert_eq!(
            NipConfig::resolve(
                &env(&[
                    ("NIP_RIGA_BRIDGE_URL", "https://example.com"),
                    ("NIP_RIGA_BRIDGE_TOKEN", "fixture-bearer-token"),
                ]),
                root,
                None,
                true,
            )
            .unwrap_err(),
            ConfigError::InvalidRigaBridgeUrl
        );
        assert_eq!(
            NipConfig::resolve(
                &env(&[("NIP_RIGA_BRIDGE_URL", "http://127.0.0.1:49152")]),
                root,
                None,
                true,
            )
            .unwrap_err(),
            ConfigError::MissingRigaBridgeToken
        );
        assert_eq!(
            NipConfig::resolve(
                &env(&[("NIP_RIGA_BRIDGE_TOKEN", "fixture-bearer-token")]),
                root,
                None,
                true,
            )
            .unwrap_err(),
            ConfigError::RigaBridgeTokenWithoutUrl
        );
    }
}
