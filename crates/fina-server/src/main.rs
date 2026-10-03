//! HTTP/REST adapter over [`fina_kernel`].
//!
//! STATUS: placeholder. Implemented in Phase 5b.
//!
//! This crate must stay a **thin transport shim**. It deserialises a request,
//! calls `fina-kernel`, and serialises the result. It must contain no formulas,
//! no domain defaults, and no branching on domain values — otherwise the CLI and
//! Tauri adapters silently diverge from the web transport.

fn main() {
    eprintln!(
        "fina-server: not yet implemented (Phase 5b). See PHASE1_MIGRATION_PROMPT.md section 5b."
    );
    std::process::exit(1);
}
