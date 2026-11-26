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
import { resolve } from 'node:path'

export function localEnvCandidates(projectRoot) {
  return [
    resolve(projectRoot, '.env'),
    resolve(projectRoot, 'modules/tac-engine/.env'),
    resolve(projectRoot, 'modules/riga-flow/.env'),
  ]
}

export function loadLocalEnv(projectRoot, env = process.env) {
  const loaded = []
  const seen = new Set()
  for (const file of localEnvCandidates(projectRoot)) {
    if (!existsSync(file)) continue
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const entry = line.startsWith('export ') ? line.slice('export '.length) : line
      const equals = entry.indexOf('=')
      if (equals <= 0) continue
      const key = entry.slice(0, equals).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || seen.has(key)) continue
      seen.add(key)
      let value = entry.slice(equals + 1).trim()
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1)
      } else {
        value = value.replace(/\s+#.*$/, '').trim()
      }
      const profileLake = key === 'TAC_LAKE_DIR'
        ? env.FINA_PROFILE_TAC_LAKE_DIR !== undefined
          ? env.FINA_PROFILE_TAC_LAKE_DIR || null
          : env.FINA_DATA_ROOT ? resolve(env.FINA_DATA_ROOT, 'lake') : null
        : null
      if (env[key] !== undefined && env[key] !== profileLake && !isEnvPlaceholder(env[key])) continue
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
