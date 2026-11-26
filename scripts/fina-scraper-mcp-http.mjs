#!/usr/bin/env node
/**
 * Launch the `fina-scraper` MCP server over Streamable HTTP on loopback.
 *
 * Usage:
 *   node scripts/fina-scraper-mcp-http.mjs
 *   npm run mcp:http:fina-scraper
 *
 * Listens on http://127.0.0.1:8798/mcp by default (port overridable via
 * `FINA_SCRAPER_HTTP_PORT`). The server speaks Streamable HTTP natively,
 * so — unlike the tac-engine bridge — this launcher only resolves the
 * binary and execs it; there is no stdio↔HTTP translation here.
 *
 * `NIP_LAKE_DIR` must come from the host environment (never a hardcoded
 * lake path). Exits 1 with an actionable message when the binary is
 * missing or `NIP_LAKE_DIR` is unset; dev launchers treat this launcher
 * as optional and keep going without the sidecar.
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

const port = Number(process.env.FINA_SCRAPER_HTTP_PORT ?? 8798);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`FINA_SCRAPER_HTTP_PORT must be a valid port number, got: ${process.env.FINA_SCRAPER_HTTP_PORT}`);
}

const child = spawn(
  binary,
  ["mcp", "--transport", "streamable-http", "--bind", `127.0.0.1:${port}`],
  { stdio: "inherit", env: process.env, windowsHide: true },
);
console.log(`[fina-scraper] MCP at http://127.0.0.1:${port}/mcp (NIP_LAKE_DIR=${lakeDir})`);
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
