/**
 * Resolve the `fina-scraper` MCP sidecar binary.
 *
 * Resolution order (mirrors the Rust `engine_binary_candidates` order used
 * for riga-mcp / tac-engine: shared workspace target first, then the
 * submodule-local target):
 *
 *   1. `FINA_SCRAPER_BIN` — explicit host override. If it is set but does
 *      not point at a file, resolution fails loudly instead of silently
 *      falling back to a different binary.
 *   2. `<CARGO_TARGET_DIR or modules/target>/release/fina-scraper`
 *   3. `<CARGO_TARGET_DIR or modules/target>/debug/fina-scraper`
 *   4. `modules/fina-scraper/target/release/fina-scraper`
 *   5. `modules/fina-scraper/target/debug/fina-scraper`
 *
 * The submodule checkout (`modules/fina-scraper`) is the canonical home of
 * the binary once it is initialised and built; the override exists so a
 * sibling `fina-scraper` checkout (or a prebuilt binary) can be used
 * without editing checked-in config.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FINA_SCRAPER_BIN_ENV = "FINA_SCRAPER_BIN";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function exeName() {
  return process.platform === "win32" ? "fina-scraper.exe" : "fina-scraper";
}

export function finaScraperCandidates(projectRoot = root, env = process.env) {
  const exe = exeName();
  const sharedTarget = env.CARGO_TARGET_DIR ?? resolve(projectRoot, "modules", "target");
  return [
    resolve(sharedTarget, "release", exe),
    resolve(sharedTarget, "debug", exe),
    resolve(projectRoot, "modules", "fina-scraper", "target", "release", exe),
    resolve(projectRoot, "modules", "fina-scraper", "target", "debug", exe),
  ];
}

/**
 * Return the resolved binary path, or `null` when no candidate exists.
 * Throws when `FINA_SCRAPER_BIN` is set but does not point at a file.
 */
export function resolveFinaScraperBin(projectRoot = root, env = process.env) {
  const explicit = env[FINA_SCRAPER_BIN_ENV]?.trim();
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new Error(
      `${FINA_SCRAPER_BIN_ENV} is set but does not point at a file: ${explicit}`,
    );
  }
  return finaScraperCandidates(projectRoot, env).find((candidate) => existsSync(candidate)) ?? null;
}

/** Human-readable remediation for a missing binary. */
export function finaScraperBinMissingHelp(projectRoot = root, env = process.env) {
  return (
    "fina-scraper binary not found. Build the submodule " +
    "(`npm run mcp:sidecar:fina-scraper`, or cargo build --release with " +
    "CARGO_TARGET_DIR=modules/target to land in the shared target dir) " +
    `or set ${FINA_SCRAPER_BIN_ENV} to a built binary. ` +
    `Looked in: ${finaScraperCandidates(projectRoot, env).join(", ")}`
  );
}
