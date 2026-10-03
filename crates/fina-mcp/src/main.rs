//! Model Context Protocol adapter over [`fina_kernel`] — **stub, Phase 2**.
//!
//! # Deliberately not implemented in Phase 1
//!
//! Phase 1 ships three transports: Tauri IPC (desktop), HTTP (web) and CLI
//! (headless). MCP is scoped out so the Phase 1 core and adapter work stays
//! reviewable.
//!
//! # What Phase 2 will do
//!
//! Speak JSON-RPC 2.0 over stdio, exposing each `fina-kernel` command as an MCP
//! tool, reusing the request/response types from `fina-kernel::api` verbatim so
//! results stay byte-identical to the other transports. Errors map through
//! [`fina_kernel::FinaError::code`] to the JSON-RPC codes in that table.
//!
//! # Why the layering rule still applies
//!
//! When implemented, this remains a thin adapter: deserialize JSON-RPC params,
//! call `fina-kernel`, serialize. No formulas, no domain branching.

fn main() {
    eprintln!(
        "fina-mcp: MCP transport is deferred to Phase 2. \
         See PHASE1_MIGRATION_PROMPT.md section 9 item O-7."
    );
    std::process::exit(1);
}
