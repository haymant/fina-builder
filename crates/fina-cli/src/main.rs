//! Command-line adapter over [`fina_kernel`].
//!
//! STATUS: placeholder. Implemented in Phase 5a.
//!
//! Contract for the real implementation: stdout carries **only** the JSON
//! result so it stays pipeable into `jq`; progress and diagnostics go to stderr.
//! Non-zero exit on error.

fn main() {
    eprintln!(
        "fina-cli: not yet implemented (Phase 5a). See PHASE1_MIGRATION_PROMPT.md section 5a."
    );
    std::process::exit(1);
}
