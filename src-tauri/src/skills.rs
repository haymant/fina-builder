//! File-based agent skills.
//!
//! A skill lives at `skills/<skill-name>/SKILL.md` with YAML frontmatter:
//!
//! ```markdown
//! ---
//! name: Risk summary
//! description: Summarize heuristic risk sensitivities in plain language.
//! ---
//!
//! Instruction text the model applies while the skill is active.
//! ```
//!
//! The directory is scanned on demand, so adding/editing a `SKILL.md` is picked
//! up without rebuilding. Skills only shape the system prompt; they never grant
//! capabilities.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    /// Stable id: the skill's directory name.
    pub id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    /// Absolute path to the source `SKILL.md`.
    pub path: String,
}

/// Split `---` frontmatter from the markdown body.
fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let trimmed = content.strip_prefix('\u{feff}').unwrap_or(content);
    let rest = trimmed.strip_prefix("---").unwrap_or(trimmed);
    if rest == trimmed {
        return (None, content);
    }
    // Find the closing `---` on its own line.
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let ended = offset + line.len();
        let marker = line.trim_end_matches(['\r', '\n']).trim();
        if marker == "---" {
            return (
                Some(&rest[..offset]),
                rest[ended..].trim_start_matches(['\r', '\n']),
            );
        }
        offset = ended;
    }
    (None, content)
}

/// Minimal YAML frontmatter reader for the flat `key: value` fields we use.
fn frontmatter_field(frontmatter: &str, key: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let line = line.trim();
        let Some(value) = line.strip_prefix(&format!("{key}:")) else {
            continue;
        };
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn parse_skill(dir: &Path) -> Option<AgentSkill> {
    let id = dir.file_name()?.to_str()?.to_string();
    let path = dir.join("SKILL.md");
    let content = fs::read_to_string(&path).ok()?;
    let (frontmatter, body) = split_frontmatter(&content);
    let frontmatter = frontmatter.unwrap_or("");
    // Convention: the skill name is its directory name. A frontmatter `name`
    // that disagrees is ignored so `/{name}` insertion always matches the id.
    let description = frontmatter_field(frontmatter, "description")
        .or_else(|| frontmatter_field(frontmatter, "name"))
        .unwrap_or_default();
    let instructions = body.trim().to_string();
    if instructions.is_empty() {
        return None;
    }
    Some(AgentSkill {
        id: id.clone(),
        name: id,
        description,
        instructions,
        path: path.to_string_lossy().into_owned(),
    })
}

/// Candidate skill roots, in priority order. The repo `skills/` directory is
/// used in development; a packaged build reads its app-data `skills/` copy.
fn skill_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // Packaged/managed copy (created on demand, so users can add skills).
    if let Ok(app_data) = app.path().app_data_dir() {
        roots.push(app_data.join("skills"));
    }
    // Development: the workspace root relative to the Tauri crate.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    roots.push(manifest.join("..").join("skills"));
    roots
}

fn scan_roots(roots: &[PathBuf]) -> Vec<AgentSkill> {
    let mut skills = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            if let Some(skill) = parse_skill(&dir) {
                if seen.insert(skill.id.clone()) {
                    skills.push(skill);
                }
            }
        }
    }
    skills.sort_by_key(|a| a.name.to_lowercase());
    skills
}

/// Scan the skills directories and return every valid `SKILL.md`.
#[tauri::command]
pub fn list_agent_skills(app: AppHandle) -> Result<Vec<AgentSkill>, String> {
    let roots = skill_roots(&app);
    // Ensure the managed directory exists so the UI can point users at it.
    if let Some(managed) = roots.first() {
        let _ = fs::create_dir_all(managed);
    }
    Ok(scan_roots(&roots))
}

/// Return the directory the app reads skills from (the managed copy).
#[tauri::command]
pub fn skills_dir(app: AppHandle) -> Result<String, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("skills");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_body() {
        let content = "---\nname: Risk summary\ndescription: Plain language.\n---\n\nDo the thing.";
        let (frontmatter, body) = split_frontmatter(content);
        let frontmatter = frontmatter.expect("frontmatter");
        assert_eq!(
            frontmatter_field(frontmatter, "name").as_deref(),
            Some("Risk summary")
        );
        assert_eq!(
            frontmatter_field(frontmatter, "description").as_deref(),
            Some("Plain language.")
        );
        assert_eq!(body.trim(), "Do the thing.");
    }

    #[test]
    fn body_without_frontmatter_is_kept() {
        let (frontmatter, body) = split_frontmatter("Just instructions.");
        assert!(frontmatter.is_none());
        assert_eq!(body, "Just instructions.");
    }

    #[test]
    fn quoted_values_are_unwrapped() {
        let frontmatter = "name: \"Quoted name\"\ndescription: 'single'";
        assert_eq!(
            frontmatter_field(frontmatter, "name").as_deref(),
            Some("Quoted name")
        );
        assert_eq!(
            frontmatter_field(frontmatter, "description").as_deref(),
            Some("single")
        );
    }

    #[test]
    fn skill_name_is_the_directory_name() {
        let root = std::env::temp_dir().join(format!("fina-skill-test-{}", std::process::id()));
        let dir = root.join("cashflow-explain");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: Cashflow explain\ndescription: Break it down.\n---\n\nDo the thing.",
        )
        .unwrap();
        let skill = parse_skill(&dir).expect("skill");
        assert_eq!(skill.id, "cashflow-explain");
        assert_eq!(skill.name, "cashflow-explain");
        assert_eq!(skill.description, "Break it down.");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn workspace_skills_scan() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("skills");
        if !root.is_dir() {
            return;
        }
        let skills = scan_roots(&[root]);
        assert!(!skills.is_empty(), "expected at least one skill");
        for skill in &skills {
            assert_eq!(skill.name, skill.id, "skill name must match its directory");
            assert!(!skill.instructions.is_empty());
        }
        assert!(skills.iter().any(|skill| skill.id == "cashflow-explain"));
    }
}
