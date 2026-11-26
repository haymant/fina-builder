#!/usr/bin/env node
/**
 * Launch the `fina-scraper` MCP server over stdio.
 *
 * Usage (from the repo root, or via `.mcp.json`):
 *   node scripts/fina-scraper-mcp.mjs
 *
 * The child owns the MCP protocol on stdio; this wrapper only resolves the
 * binary (see `lib/fina-scraper-bin.mjs`), requires `NIP_LAKE_DIR` from the
 * host environment (never a hardcoded lake path), and forwards signals.
 * The desktop app does NOT need this — it reaches fina-scraper over stdio
 * through its own sidecar spawn; this launcher is for MCP clients that
 * read `.mcp.json` and for `dev:http` smoke checks.
 */
import { spawn } from "node:child_process";
import { finaScraperBinMissingHelp, resolveFinaScraperBin } from "./lib/fina-scraper-bin.mjs";

function fail(message) {
  console.error(`fina-scraper: ${message}`);
  process.exit(1);
}

let binary;
try {
  binary = resolveFinaScraperBin();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (!binary) fail(finaScraperBinMissingHelp());

const lakeDir = process.env.NIP_LAKE_DIR?.trim();
if (!lakeDir || lakeDir.startsWith("${")) {
  fail(
    "NIP_LAKE_DIR is not set. Set it in the host environment to the narrative lake root " +
      "(e.g. the profile default .fina/data/nip/lake); it is never hardcoded in repo config.",
  );
}

const child = spawn(binary, ["mcp", "--transport", "stdio"], {
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});
child.once("error", (error) => fail(`failed to start ${binary}: ${error.message}`));
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (child.exitCode === null) child.kill(signal);
  });
}
