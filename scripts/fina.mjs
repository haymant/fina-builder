#!/usr/bin/env node
/**
 * Fina Builder control plane.
 *
 * This first version deliberately uses only Node's standard library. It reads the
 * repository-owned fina.toml, validates the checkout, and delegates lifecycle
 * commands to the existing package scripts. It is the stable user/CI entry point;
 * package managers and Git plumbing remain implementation details behind it.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const START_DIR = process.cwd();
const CONFIG_NAME = "fina.toml";

function fail(message, code = 1) {
  console.error(`fina: ${message}`);
  process.exitCode = code;
}

function stripComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\" && quoted) {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "#" && !quoted) {
      return line.slice(0, index);
    }
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
    for (const char of body) {
      if (char === '"') quoted = !quoted;
      if (char === "," && !quoted) {
        items.push(parseValue(current, source, lineNumber));
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim()) items.push(parseValue(current, source, lineNumber));
    return items;
  }
  throw new Error(`${source}:${lineNumber}: unsupported TOML value: ${value}`);
}

/** Parse the intentionally small TOML subset used by fina.toml. */
function parseToml(text, source) {
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
    } else {
      section[key] = parseValue(assignment[2], source, lineNumber);
    }
  }
  return result;
}

function findRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, CONFIG_NAME))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function loadProject() {
  const root = findRoot(START_DIR) ?? findRoot(SCRIPT_DIR);
  if (!root) throw new Error(`could not find ${CONFIG_NAME}; run this command inside a Fina Builder checkout`);
  const configPath = join(root, CONFIG_NAME);
  let config;
  try {
    config = parseToml(readFileSync(configPath, "utf8"), configPath);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  if (config.project?.name !== "fina-builder") {
    throw new Error(`${configPath}: project.name must be \"fina-builder\"`);
  }
  return { root, config, configPath };
}

function commandName() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function resolvePath(root, value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

function versionParts(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(actual, minimum) {
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
    child.on("exit", (code, signal) => {
      resolvePromise(signal ? 1 : code ?? 1);
    });
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
  console.log(`Fina Builder control plane\n\nUsage:\n  fina <command> [options]\n\nControl-plane commands:\n  help                 Show this help\n  config [--json]      Print the resolved fina.toml configuration\n  doctor [--json]      Check the checkout and required development tools\n  run <name> [args...] Run a command declared in fina.toml\n\nConfigured command aliases:\n  dev, web, dev_http, build, test, lint, runtime_prepare, package\n\nExamples:\n  node scripts/fina.mjs doctor\n  node scripts/fina.mjs dev\n  node scripts/fina.mjs run build\n  node scripts/fina.mjs config --json`);
}

function printConfig(project, json) {
  const resolved = {
    ...project.config,
    _resolved: {
      root: project.root,
      config: project.configPath,
      workspace_root: project.root,
      skills: resolvePath(project.root, project.config.paths.skills),
      mcp_manifest: resolvePath(project.root, project.config.mcp.manifest),
      data_root: resolvePath(project.root, project.config.profiles.development.data_root),
    },
  };
  console.log(json ? JSON.stringify(resolved, null, 2) : JSON.stringify(resolved, null, 2));
}

async function doctor(project, json) {
  const checks = [];
  const add = (name, ok, detail, required = true) => checks.push({ name, ok, detail, required });
  const nodeMin = project.config.toolchain.node_min;
  add("node", atLeast(process.versions.node, nodeMin), `${process.versions.node} (minimum ${nodeMin})`);
  add("fina.toml", existsSync(project.configPath), project.configPath);
  add("package.json", existsSync(join(project.root, "package.json")), join(project.root, "package.json"));
  add("skills", existsSync(resolvePath(project.root, project.config.paths.skills)), resolvePath(project.root, project.config.paths.skills));
  add("MCP manifest", existsSync(resolvePath(project.root, project.config.mcp.manifest)), resolvePath(project.root, project.config.mcp.manifest), false);

  const git = await capture("git", ["--version"], project.root);
  add("git", Boolean(git), git ?? "not found");
  const cargo = await capture("cargo", ["--version"], project.root);
  add("cargo", Boolean(cargo), cargo ?? "not found");
  const uv = await capture("uv", ["--version"], project.root);
  add("uv", Boolean(uv), uv ?? "not found", false);
  const npm = await capture(commandName(), ["--version"], project.root);
  add("npm", Boolean(npm), npm ?? "not found");

  const failed = checks.filter((check) => check.required && !check.ok);
  if (json) {
    console.log(JSON.stringify({ root: project.root, config: project.configPath, checks, ok: failed.length === 0 }, null, 2));
  } else {
    console.log(`Fina doctor — ${project.root}`);
    for (const check of checks) console.log(`${check.ok ? "PASS" : check.required ? "FAIL" : "WARN"}  ${check.name}: ${check.detail}`);
    console.log(failed.length ? `\n${failed.length} required check(s) failed.` : "\nAll required checks passed.");
  }
  return failed.length ? 1 : 0;
}

async function runConfigured(project, name, args) {
  const command = project.config.commands?.[name];
  if (typeof command !== "string" || !command.trim()) {
    throw new Error(`command '${name}' is not declared in ${project.configPath}`);
  }
  // The initial schema intentionally delegates to npm scripts. Validate that
  // contract here so quoting or a future non-npm command cannot fail silently.
  const match = command.trim().match(/^npm\s+run\s+([^\s]+)$/);
  if (!match) {
    throw new Error(`command '${name}' must currently use the form: npm run <script>`);
  }
  const npmArgs = ["run", match[1]];
  if (args.length) npmArgs.push("--", ...args);
  const code = await runProcess(commandName(), npmArgs, { cwd: project.root });
  return code;
}

async function main() {
  const [, , requested = "help", ...args] = process.argv;
  const project = loadProject();
  const command = requested === "run" ? args.shift() : requested;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "config") {
    printConfig(project, args.includes("--json"));
    return;
  }
  if (command === "doctor") {
    process.exitCode = await doctor(project, args.includes("--json"));
    return;
  }
  if (command === "run") throw new Error("run requires a command name; use `fina run help` or `fina help`");
  if (project.config.commands?.[command]) {
    process.exitCode = await runConfigured(project, command, args);
    return;
  }
  throw new Error(`unknown command '${command}'; use \'fina help\'`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
