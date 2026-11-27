#!/usr/bin/env node
/**
 * Fina Builder control plane.
 *
 * This launcher owns project discovery, profile-aware path resolution, environment
 * construction, diagnostics, and dispatch. Ecosystem lockfiles and existing npm
 * scripts remain authoritative behind this stable interface.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { finaScraperCandidates } from "./lib/fina-scraper-bin.mjs";
import { isEnvPlaceholder, loadLocalEnv, tauriAppDataDir } from "./lib/local-env.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const START_DIR = process.cwd();
const CONFIG_NAME = "fina.toml";
const DEFAULT_PROFILE = "development";
const SUPPORTED_CONFIG_VERSION = 1;

function stripComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) escaped = false;
    else if (char === "\\" && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (char === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}

function parseValue(raw, source, lineNumber) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${source}:${lineNumber}: invalid string value`);
    }
  }
  if (value === "true" || value === "false") return value === "true";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    if (!body) return [];
    const items = [];
    let current = "";
    let quoted = false;
    let escaped = false;
    for (const char of body) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (char === "\\" && quoted) {
        current += char;
        escaped = true;
        continue;
      }
      if (char === '"') quoted = !quoted;
      if (char === "," && !quoted) {
        items.push(parseValue(current, source, lineNumber));
        current = "";
      } else current += char;
    }
    if (current.trim()) items.push(parseValue(current, source, lineNumber));
    return items;
  }
  throw new Error(`${source}:${lineNumber}: unsupported TOML value: ${value}`);
}

/** Parse the intentionally small TOML subset used by fina.toml. */
export function parseToml(text, source = "fina.toml") {
  const result = {};
  let section = result;
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = stripComment(original).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = result;
      for (const part of sectionMatch[1].split(".")) {
        section[part] ??= {};
        if (typeof section[part] !== "object" || Array.isArray(section[part])) {
          throw new Error(`${source}:${lineNumber}: section conflicts with a value`);
        }
        section = section[part];
      }
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!assignment) throw new Error(`${source}:${lineNumber}: expected a section or key = value`);
    const key = assignment[1];
    if (key.includes(".")) {
      const parts = key.split(".");
      let target = section;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      target[parts.at(-1)] = parseValue(assignment[2], source, lineNumber);
    } else section[key] = parseValue(assignment[2], source, lineNumber);
  }
  return result;
}

export function findRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, CONFIG_NAME))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function resolvePath(root, value, label = "path") {
  const path = requireString(value, label);
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

export function selectProfile(config, profile = DEFAULT_PROFILE) {
  const selected = profile?.trim() || DEFAULT_PROFILE;
  const profiles = config.profiles;
  if (!profiles || typeof profiles[selected] !== "object" || Array.isArray(profiles[selected])) {
    const available = profiles ? Object.keys(profiles).join(", ") : "none";
    throw new Error(`unknown profile '${selected}' (available: ${available})`);
  }
  return { name: selected, values: profiles[selected] };
}

export function resolveProject(project, profile = DEFAULT_PROFILE) {
  const selected = selectProfile(project.config, profile);
  const paths = project.config.paths ?? {};
  const profileDataRoot = selected.values.data_root ?? paths.local_data;
  const resolvedPaths = {
    frontend: resolvePath(project.root, paths.frontend, "paths.frontend"),
    rust_workspace: resolvePath(project.root, paths.rust_workspace, "paths.rust_workspace"),
    rust_target: resolvePath(project.root, paths.rust_target, "paths.rust_target"),
    skills: resolvePath(project.root, paths.skills, "paths.skills"),
    modules: resolvePath(project.root, paths.modules, "paths.modules"),
    qlib: resolvePath(project.root, paths.qlib, "paths.qlib"),
    data_root: resolvePath(project.root, profileDataRoot, "profile data_root"),
    local_data: resolvePath(project.root, paths.local_data, "paths.local_data"),
    experiment_repository: resolvePath(project.root, paths.experiment_repository, "paths.experiment_repository"),
    mcp_manifest: resolvePath(project.root, project.config.mcp?.manifest, "mcp.manifest"),
  };
  resolvedPaths.tac_lake = resolvePath(project.root, selected.values.tac_lake ?? join(profileDataRoot, "lake"), "profile tac_lake");
  const defaultNipLake = selected.name === "packaged"
    ? join(tauriAppDataDir(), "NIPLake")
    : join(profileDataRoot, "nip", "lake");
  resolvedPaths.nip_lake = resolvePath(project.root, selected.values.nip_lake ?? defaultNipLake, "profile nip_lake");
  resolvedPaths.nip_data = join(resolvedPaths.nip_lake, "_nip");
  return {
    ...project,
    profile: selected.name,
    profile_config: selected.values,
    paths: resolvedPaths,
  };
}

export function buildRuntimeEnvironment(project, baseEnv = process.env) {
  const releaseTarget = join(project.paths.rust_target, "release");
  const hasValue = (value) => value !== undefined && value !== "" && !isEnvPlaceholder(value);
  const profileTacLake = project.paths.tac_lake;
  const profileNipLake = project.paths.nip_lake;
  const inheritedTacDefault = baseEnv.FINA_PROFILE_TAC_LAKE_DIR && baseEnv.TAC_LAKE_DIR === baseEnv.FINA_PROFILE_TAC_LAKE_DIR;
  const inheritedNipDefault = baseEnv.FINA_PROFILE_NIP_LAKE_DIR && baseEnv.NIP_LAKE_DIR === baseEnv.FINA_PROFILE_NIP_LAKE_DIR;
  const hasExplicitTacLake = hasValue(baseEnv.TAC_LAKE_DIR) && !inheritedTacDefault;
  const hasExplicitNipLake = hasValue(baseEnv.NIP_LAKE_DIR) && !inheritedNipDefault;
  if (hasValue(baseEnv.NIP_DATA_DIR)) {
    console.warn("Ignoring NIP_DATA_DIR; it is derived from NIP_LAKE_DIR.");
  }
  const nipLake = resolvePath(project.root, hasValue(baseEnv.NIP_LAKE_DIR) ? baseEnv.NIP_LAKE_DIR : profileNipLake, "NIP_LAKE_DIR");
  return {
    FINA_PROFILE: project.profile,
    FINA_ROOT: project.root,
    FINA_WORKSPACE_ROOT: project.root,
    FINA_DATA_ROOT: project.paths.data_root,
    // Local dotenv files may replace these injected defaults, but not explicit
    // process values (including a value that happens to equal the default).
    FINA_PROFILE_TAC_LAKE_DIR: hasExplicitTacLake ? "" : profileTacLake,
    FINA_PROFILE_NIP_LAKE_DIR: hasExplicitNipLake ? "" : profileNipLake,
    FINA_RUST_TARGET_DIR: project.paths.rust_target,
    FINA_QLIB_ROOT: project.paths.qlib,
    CARGO_TARGET_DIR: baseEnv.CARGO_TARGET_DIR ?? project.paths.rust_target,
    TAC_LAKE_DIR: hasValue(baseEnv.TAC_LAKE_DIR) ? baseEnv.TAC_LAKE_DIR : project.paths.tac_lake,
    NIP_DATA_DIR: join(nipLake, "_nip"),
    NIP_LAKE_DIR: nipLake,
    TAC_ENGINE_BIN: baseEnv.TAC_ENGINE_BIN ?? join(releaseTarget, process.platform === "win32" ? "tac-engine.exe" : "tac-engine"),
    // fina-scraper sidecar (revamp F1): only forward an explicit override.
    // The launcher resolves an unset value at spawn time, after
    // `runtime:prepare` has built the shared target binary, instead of
    // pinning a path that may not exist yet.
    ...(baseEnv.FINA_SCRAPER_BIN ? { FINA_SCRAPER_BIN: baseEnv.FINA_SCRAPER_BIN } : {}),
    TAC_QLIB_PYTHON_BIN: baseEnv.TAC_QLIB_PYTHON_BIN ?? join(project.paths.modules, ".venv", process.platform === "win32" ? "Scripts" : "bin", "python"),
  };
}

export function loadProject(start = START_DIR, requestedProfile = DEFAULT_PROFILE) {
  const root = findRoot(start) ?? findRoot(SCRIPT_DIR);
  if (!root) throw new Error(`could not find ${CONFIG_NAME}; run this command inside a Fina Builder checkout`);
  const configPath = join(root, CONFIG_NAME);
  let config;
  try {
    config = parseToml(readFileSync(configPath, "utf8"), configPath);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  if (config.project?.name !== "fina-builder") throw new Error(`${configPath}: project.name must be "fina-builder"`);
  if (config.project?.config_version !== SUPPORTED_CONFIG_VERSION) {
    throw new Error(`${configPath}: project.config_version must be ${SUPPORTED_CONFIG_VERSION}`);
  }
  return resolveProject({ root, config, configPath }, requestedProfile);
}

function commandName() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function versionParts(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

export function atLeast(actual, minimum) {
  const a = versionParts(actual);
  const b = versionParts(minimum);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return true;
    if (a[index] < b[index]) return false;
  }
  return true;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolvePromise(signal ? 1 : code ?? 1));
  });
}

async function capture(command, args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", () => resolvePromise(null));
    child.on("exit", (code) => resolvePromise(code === 0 ? output.trim() : null));
  });
}

function printHelp() {
  console.log(`Fina Builder control plane\n\nUsage:\n  fina [--profile <name>] <command> [options]\n\nControl-plane commands:\n  help                 Show this help\n  config [--json]      Print the resolved fina.toml configuration\n  doctor [--json]      Check the checkout and required development tools\n  run <name> [args...] Run a command declared in fina.toml\n\nProfiles:\n  development          Local checkout and ignored .fina/data root (default)\n  ci                   CI paths and release Rust build policy\n  packaged             Immutable-install layout with NIP data in Tauri app data\n\nConfigured command aliases:\n  dev, web, dev_http, desktop, build, test, lint, runtime_prepare, package`);
}

function printConfig(project, json, runtimeEnv) {
  const output = {
    ...project.config,
    _resolved: {
      root: project.root,
      config: project.configPath,
      profile: project.profile,
      profile_config: project.profile_config,
      workspace_root: project.root,
      ...project.paths,
      NIP_LAKE_DIR: runtimeEnv.NIP_LAKE_DIR,
      NIP_DATA_DIR: runtimeEnv.NIP_DATA_DIR,
      TAC_LAKE_DIR: runtimeEnv.TAC_LAKE_DIR,
      nip_lake: runtimeEnv.NIP_LAKE_DIR,
      nip_data: runtimeEnv.NIP_DATA_DIR,
    },
  };
  console.log(json ? JSON.stringify(output, null, 2) : JSON.stringify(output, null, 2));
}

export async function doctor(project, json) {
  const checks = [];
  const add = (name, ok, detail, required = true) => checks.push({ name, ok, detail, required });
  const nodeMin = project.config.toolchain?.node_min;
  add("node", atLeast(process.versions.node, nodeMin), `${process.versions.node} (minimum ${nodeMin})`);
  add("config version", project.config.project?.config_version === SUPPORTED_CONFIG_VERSION, `supported version ${SUPPORTED_CONFIG_VERSION}`);
  add("fina.toml", existsSync(project.configPath), project.configPath);
  add("package.json", existsSync(join(project.root, "package.json")), join(project.root, "package.json"));
  add("version source", existsSync(join(project.root, project.config.project.version_source)), project.config.project.version_source);
  add("skills", existsSync(project.paths.skills), project.paths.skills);
  add("MCP manifest", existsSync(project.paths.mcp_manifest), project.paths.mcp_manifest, false);
  add("rust toolchain", existsSync(resolvePath(project.root, project.config.toolchain.rust_toolchain_file, "rust_toolchain_file")), project.config.toolchain.rust_toolchain_file, false);
  add("profile data root", !isAbsolute(project.profile_config.data_root), `${project.profile} → ${project.paths.data_root}`);

  const git = await capture("git", ["--version"], project.root);
  add("git", Boolean(git), git ?? "not found");
  const cargo = await capture("cargo", ["--version"], project.root);
  add("cargo", Boolean(cargo), cargo ?? "not found");
  const uv = await capture("uv", ["--version"], project.root);
  add("uv", Boolean(uv), uv ?? "not found", false);
  const npm = await capture(commandName(), ["--version"], project.root);
  add("npm", Boolean(npm), npm ?? "not found");

  // Revamp F1 — fina-scraper sidecar: the binary must resolve and the lake
  // dir must be set (host env wins, else the profile default). The binary
  // check is required: without it `tools/list` cannot show the scraper
  // tools. Remediation is in the detail when the binary is missing.
  const runtimeEnv = buildRuntimeEnvironment(project);
  const scraperCandidates = finaScraperCandidates(project.root, process.env);
  const scraperBin = process.env.FINA_SCRAPER_BIN?.trim()
    || scraperCandidates.find((candidate) => existsSync(candidate))
    || null;
  const scraperReady = Boolean(scraperBin && existsSync(scraperBin));
  add(
    "fina-scraper binary",
    scraperReady,
    scraperReady
      ? scraperBin
      : `${scraperBin ?? scraperCandidates[0]} (not found; run npm run mcp:sidecar:fina-scraper, or set FINA_SCRAPER_BIN)`,
  );
  const nipLake = runtimeEnv.NIP_LAKE_DIR;
  add(
    "NIP_LAKE_DIR",
    Boolean(nipLake),
    nipLake
      ? `${nipLake}${process.env.NIP_LAKE_DIR ? " (host env or .env)" : " (profile default)"}`
      : "not set (set NIP_LAKE_DIR in the host env or .env, or rely on the profile default)",
  );
  add("NIP_DATA_DIR", Boolean(runtimeEnv.NIP_DATA_DIR), runtimeEnv.NIP_DATA_DIR);

  const failed = checks.filter((check) => check.required && !check.ok);
  if (json) console.log(JSON.stringify({
    root: project.root,
    config: project.configPath,
    profile: project.profile,
    paths: { ...project.paths, nip_lake: runtimeEnv.NIP_LAKE_DIR, nip_data: runtimeEnv.NIP_DATA_DIR },
    effective_environment: { NIP_LAKE_DIR: runtimeEnv.NIP_LAKE_DIR, NIP_DATA_DIR: runtimeEnv.NIP_DATA_DIR, TAC_LAKE_DIR: runtimeEnv.TAC_LAKE_DIR },
    checks,
    ok: failed.length === 0,
  }, null, 2));
  else {
    console.log(`Fina doctor — ${project.root} (${project.profile})`);
    for (const check of checks) console.log(`${check.ok ? "PASS" : check.required ? "FAIL" : "WARN"}  ${check.name}: ${check.detail}`);
    console.log(failed.length ? `\n${failed.length} required check(s) failed.` : "\nAll required checks passed.");
  }
  return failed.length ? 1 : 0;
}

async function runConfigured(project, name, args) {
  const command = project.config.commands?.[name];
  if (typeof command !== "string" || !command.trim()) throw new Error(`command '${name}' is not declared in ${project.configPath}`);
  const match = command.trim().match(/^npm\s+run\s+([^\s]+)$/);
  if (!match) throw new Error(`command '${name}' must currently use the form: npm run <script>`);
  const env = buildRuntimeEnvironment(project);
  const npmArgs = ["run", match[1]];
  if (args.length) npmArgs.push("--", ...args);
  return runProcess(commandName(), npmArgs, { cwd: project.root, env });
}

function parseInvocation(argv) {
  let profile = DEFAULT_PROFILE;
  const remaining = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--profile") {
      profile = argv[++index];
      if (!profile) throw new Error("--profile requires a profile name");
    } else if (value.startsWith("--profile=")) profile = value.slice("--profile=".length);
    else remaining.push(value);
  }
  return { profile, args: remaining };
}

export async function main(argv = process.argv.slice(2), start = START_DIR) {
  const invocation = parseInvocation(argv);
  const [requested = "help", ...args] = invocation.args;
  const project = loadProject(start, invocation.profile);
  // Read the same ignored `.env` files as the desktop host and dev:http so
  // configured commands (and doctor) see the user's lake/database/provider
  // settings. Explicit shell exports still win; `loadLocalEnv` only lets a
  // local file replace the profile lake default it injected itself.
  const loadedEnv = loadLocalEnv(project.root, process.env, { cwd: start });
  const runtimeEnv = buildRuntimeEnvironment(project);
  const command = requested === "run" ? args.shift() : requested;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (command === "config") {
    printConfig(project, args.includes("--json"), runtimeEnv);
    return 0;
  }
  if (command === "doctor") return doctor(project, args.includes("--json"));
  if (command === "run" || !project.config.commands?.[command]) {
    throw new Error(command === "run" ? "run requires a command name; use `fina help`" : `unknown command '${command}'; use 'fina help'`);
  }
  if (loadedEnv.length > 0) console.error(`fina: loaded local environment from ${loadedEnv.join(", ")}`);
  return runConfigured(project, command, args);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`fina: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
