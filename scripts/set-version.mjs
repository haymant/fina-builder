#!/usr/bin/env node
// Writes ONE version into every place the version is declared, so a release tag
// and the binaries it produces cannot disagree.
//
//   node scripts/set-version.mjs 0.1.1        # or: npm run version:set -- 0.1.1
//   node scripts/set-version.mjs v0.1.1       # leading `v` is stripped
//
// Touched files:
//   Cargo.toml              [workspace.package] version   (fina-cli, fina-server, fina-mcp)
//   src-tauri/Cargo.toml    [package] version             (the Tauri crate is not in the workspace)
//   src-tauri/tauri.conf.json version                     (bundles, `/health`, the Tauri binary)
//
// `cargo` also needs `Cargo.lock` refreshed when the version changes; run
// `cargo check -p fina-cli` (or commit the lockfile update) after this script.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SEMVER =
  /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

const root = resolve(import.meta.dirname, '..')

/** Fails loudly rather than writing a version Cargo would reject later. */
function normalize(input) {
  const version = String(input ?? '').trim().replace(/^v/, '')
  if (!SEMVER.test(version)) {
    console.error(
      `set-version: "${input}" is not a semver version (expected MAJOR.MINOR.PATCH[-tag])`,
    )
    process.exit(2)
  }
  return version
}

/** Replaces the first `key = "..."` occurrence, leaving every other line alone. */
function setTomlVersion(relativePath, key, version) {
  const path = resolve(root, relativePath)
  const before = readFileSync(path, 'utf8')
  const pattern = new RegExp(`^(${key}\\s*=\\s*)"[^"]*"`, 'm')
  if (!pattern.test(before)) {
    console.error(`set-version: no \`${key} = "…"\` line in ${relativePath}`)
    process.exit(2)
  }
  writeFileSync(path, before.replace(pattern, `$1"${version}"`))
  console.log(`  ${relativePath}: ${key} = "${version}"`)
}

function setTauriVersion(version) {
  const relativePath = 'src-tauri/tauri.conf.json'
  const path = resolve(root, relativePath)
  const before = readFileSync(path, 'utf8')
  const pattern = /("version"\s*:\s*)"[^"]*"/
  if (!pattern.test(before)) {
    console.error(`set-version: no "version" key in ${relativePath}`)
    process.exit(2)
  }
  writeFileSync(path, before.replace(pattern, `$1"${version}"`))
  console.log(`  ${relativePath}: version = "${version}"`)
}

const version = normalize(process.argv[2])
console.log(`set-version: writing ${version}`)
setTomlVersion('Cargo.toml', 'version', version)
setTomlVersion('src-tauri/Cargo.toml', 'version', version)
setTauriVersion(version)
console.log('set-version: done (remember to commit Cargo.lock)')
