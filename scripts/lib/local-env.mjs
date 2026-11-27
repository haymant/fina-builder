/**
 * Load the checkout's ignored local `.env` files for development launchers.
 *
 * The desktop host, `dev:http`, and the sidecar wrappers all read the same
 * files so browser and Tauri sessions see the same lake, database, and
 * provider configuration. Explicit shell values win; earlier files win over
 * later ones. Only the launcher-injected profile lake default may be replaced
 * by a local `.env`, so `fina dev_http`/`fina desktop` can still point at a
 * pre-populated lake without requiring manual exports.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const TAURI_APP_ID = 'com.fina.payoffexplorer'

/** Match Tauri's platform-specific application support/data directory. */
export function tauriAppDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', TAURI_APP_ID)
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), TAURI_APP_ID)
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), TAURI_APP_ID)
}

export function localEnvCandidates(projectRoot, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const appDataDir = options.appDataDir ?? tauriAppDataDir()
  return [...new Set([
    resolve(cwd, '.env'),
    resolve(appDataDir, '.env'),
    resolve(projectRoot, '.env'),
    resolve(projectRoot, 'modules/tac-engine/.env'),
    resolve(projectRoot, 'modules/riga-flow/.env'),
  ])]
}

export function loadLocalEnv(projectRoot, env = process.env, options = {}) {
  const loaded = []
  const seen = new Set()
  let warnedAboutLegacyDataDir = false
  for (const file of localEnvCandidates(projectRoot, options)) {
    if (!existsSync(file)) continue
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const entry = line.startsWith('export ') ? line.slice('export '.length) : line
      const equals = entry.indexOf('=')
      if (equals <= 0) continue
      const key = entry.slice(0, equals).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || seen.has(key)) continue
      let value = entry.slice(equals + 1).trim()
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1)
      } else {
        value = value.replace(/\s+#.*$/, '').trim()
      }
      if (isEnvPlaceholder(value)) continue
      if (key === 'NIP_DATA_DIR') {
        if (!warnedAboutLegacyDataDir) {
          console.warn('Ignoring NIP_DATA_DIR from local environment; it is derived from NIP_LAKE_DIR.')
          warnedAboutLegacyDataDir = true
        }
        seen.add(key)
        continue
      }
      const profileValue = key === 'TAC_LAKE_DIR'
        ? env.FINA_PROFILE_TAC_LAKE_DIR
        : key === 'NIP_LAKE_DIR'
          ? env.FINA_PROFILE_NIP_LAKE_DIR
          : undefined
      const isInjectedProfileValue = Boolean(profileValue && env[key] === profileValue)
      seen.add(key)
      if (env[key] !== undefined && env[key] !== '' && !isEnvPlaceholder(env[key]) && !isInjectedProfileValue) continue
      env[key] = value
    }
    loaded.push(file.slice(projectRoot.length + 1))
  }
  return loaded
}

/** True when a value is an unexpanded `${VAR}` placeholder from `.mcp.json`. */
export function isEnvPlaceholder(value) {
  return typeof value === 'string' && /^\$\{[^}]+\}$/.test(value)
}
