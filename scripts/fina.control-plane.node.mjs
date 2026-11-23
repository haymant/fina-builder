import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { atLeast, buildRuntimeEnvironment, findRoot, parseToml, resolveProject, selectProfile } from "./fina.mjs";
import { loadLocalEnv } from "./dev-http.mjs";

const execFileAsync = promisify(execFile);
const launcher = join(process.cwd(), "scripts", "fina.mjs");

function configText(overrides = "") {
  return `
[project]
name = "fina-builder"
config_version = 1
version_source = "package.json"

[toolchain]
node_min = "22.19.0"
rust_toolchain_file = "rust-toolchain.toml"
python_manager = "uv"

[paths]
frontend = "."
rust_workspace = "."
rust_target = "modules/target"
skills = "skills"
modules = "modules"
qlib = "modules/tac-qlib"
local_data = ".fina/data"
experiment_repository = ".fina/experiments"

[mcp]
manifest = ".mcp.json"

[profiles.development]
use_source_modules = true
build_mode = "debug"
data_root = ".fina/data"

[profiles.ci]
use_source_modules = true
build_mode = "release"
data_root = ".fina/ci-data"

[profiles.packaged]
use_source_modules = false
build_mode = "release"
data_root = "platform-data"

[commands]
help = "npm run lint"
${overrides}
`;
}

async function cli(args, cwd) {
  return execFileAsync(process.execPath, [launcher, ...args], { cwd, env: process.env });
}

test("parses the supported TOML subset and preserves arrays", () => {
  const parsed = parseToml('[section]\nname = "fina"\nflag = true\nitems = ["a", "b"]');
  assert.deepEqual(parsed, { section: { name: "fina", flag: true, items: ["a", "b"] } });
});

test("finds fina.toml from a descendant directory", async () => {
  const root = await mkdtemp(join("/tmp", "fina-root-"));
  const nested = join(root, "one", "two");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "fina.toml"), configText());
  assert.equal(findRoot(nested), root);
  await rm(root, { recursive: true, force: true });
});

test("selects known profiles and rejects unknown profiles", () => {
  const config = { profiles: { development: { data_root: ".fina/data" }, ci: { data_root: ".fina/ci-data" } } };
  assert.equal(selectProfile(config, "ci").values.data_root, ".fina/ci-data");
  assert.throws(() => selectProfile(config, "missing"), /unknown profile 'missing'/);
});

test("derives profile-aware service paths without credentials", () => {
  const root = "/tmp/fina-runtime";
  const config = parseToml(configText());
  const project = resolveProject({ root, config, configPath: join(root, "fina.toml") }, "ci");
  const env = buildRuntimeEnvironment(project, {});
  assert.equal(env.FINA_DATA_ROOT, join(root, ".fina", "ci-data"));
  assert.equal(env.TAC_LAKE_DIR, join(root, ".fina", "ci-data", "lake"));
  assert.equal(env.FINA_PROFILE_TAC_LAKE_DIR, join(root, ".fina", "ci-data", "lake"));
  assert.equal(env.NIP_DATA_DIR, join(root, ".fina", "ci-data", "nip"));
  assert.equal(env.NIP_LAKE_DIR, join(root, ".fina", "ci-data", "nip", "lake"));
  assert.equal(env.TAC_ENGINE_BIN, join(root, "modules", "target", "release", "tac-engine"));
  assert.equal(env.TAC_QLIB_PYTHON_BIN, join(root, "modules", ".venv", "bin", "python"));
  assert.equal(Object.keys(env).some((key) => /KEY|SECRET|TOKEN|PASSWORD/i.test(key)), false);
});

test("preserves explicit service path and binary overrides", () => {
  const root = "/tmp/fina-runtime-overrides";
  const config = parseToml(configText());
  const project = resolveProject({ root, config, configPath: join(root, "fina.toml") });
  const env = buildRuntimeEnvironment(project, {
    TAC_LAKE_DIR: "/tmp/custom-lake",
    TAC_ENGINE_BIN: "/tmp/custom-tac-engine",
  });
  assert.equal(env.TAC_LAKE_DIR, "/tmp/custom-lake");
  assert.equal(env.FINA_PROFILE_TAC_LAKE_DIR, "");
  assert.equal(env.TAC_ENGINE_BIN, "/tmp/custom-tac-engine");
  assert.equal(env.NIP_DATA_DIR, join(root, ".fina", "data", "nip"));
});

test("dev-http dotenv replaces only the launcher profile lake default", async () => {
  const root = await mkdtemp(join("/tmp", "fina-dev-http-env-"));
  await mkdir(join(root, "modules", "tac-engine"), { recursive: true });
  await writeFile(join(root, ".env"), "TAC_LAKE_DIR=/env/lake\nTAC_LAKE_START_DATE=2000-01-03\nSHARED=root\n");
  await writeFile(join(root, "modules", "tac-engine", ".env"), "TAC_LAKE_DIR=/module/lake\nTAC_LAKE_START_DATE=2010-01-01\n");

  const profileEnv = {
    FINA_PROFILE_TAC_LAKE_DIR: "/profile/lake",
    TAC_LAKE_DIR: "/profile/lake",
    SHARED: "shell",
  };
  loadLocalEnv(root, profileEnv);
  assert.equal(profileEnv.TAC_LAKE_DIR, "/env/lake");
  assert.equal(profileEnv.TAC_LAKE_START_DATE, "2000-01-03");
  assert.equal(profileEnv.SHARED, "shell");

  const explicitEnv = { TAC_LAKE_DIR: "/explicit/lake" };
  loadLocalEnv(root, explicitEnv);
  assert.equal(explicitEnv.TAC_LAKE_DIR, "/explicit/lake");
  assert.equal(explicitEnv.TAC_LAKE_START_DATE, "2000-01-03");
  await rm(root, { recursive: true, force: true });
});

test("compares toolchain versions numerically", () => {
  assert.equal(atLeast("22.19.0", "22.19.0"), true);
  assert.equal(atLeast("22.20.0", "22.19.0"), true);
  assert.equal(atLeast("22.18.9", "22.19.0"), false);
});

test("config --json reports the selected profile and resolved data root", async () => {
  const root = await mkdtemp(join("/tmp", "fina-config-"));
  await writeFile(join(root, "fina.toml"), configText());
  const { stdout } = await cli(["--profile", "ci", "config", "--json"], root);
  const output = JSON.parse(stdout);
  assert.equal(output._resolved.profile, "ci");
  assert.equal(output._resolved.data_root, join(root, ".fina", "ci-data"));
  await rm(root, { recursive: true, force: true });
});

test("malformed config fails with a source location", async () => {
  const root = await mkdtemp(join("/tmp", "fina-invalid-"));
  await writeFile(join(root, "fina.toml"), "[project]\nname = \"fina-builder\"\ninvalid");
  await assert.rejects(cli(["config", "--json"], root), /expected a section or key = value/);
  await rm(root, { recursive: true, force: true });
});

test("doctor --json returns a structured result for a checkout", async () => {
  const root = await mkdtemp(join("/tmp", "fina-doctor-"));
  await mkdir(join(root, "skills"));
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "rust-toolchain.toml"), "[toolchain]\nchannel = \"stable\"\n");
  await writeFile(join(root, ".mcp.json"), "{}\n");
  await writeFile(join(root, "fina.toml"), configText());
  const { stdout } = await cli(["--profile=development", "doctor", "--json"], root);
  const output = JSON.parse(stdout);
  assert.equal(output.profile, "development");
  assert.equal(typeof output.ok, "boolean");
  assert.ok(Array.isArray(output.checks));
  await rm(root, { recursive: true, force: true });
});
