/**
 * Apply the control-plane runtime environment to a launcher's `process.env`.
 *
 * This is the shared bridge between `fina.mjs` and the scripts Tauri or npm
 * start directly (`dev:tauri`, `mcp:http:fina-scraper`, the stdio wrapper):
 * load the checkout `.env`, then fill profile defaults such as `NIP_LAKE_DIR`
 * only where the caller did not supply a value. Explicit shell values still
 * win, and literal `${VAR}` placeholders from `.mcp.json` count as unset.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildRuntimeEnvironment, loadProject } from '../fina.mjs'
import { isEnvPlaceholder, loadLocalEnv } from './local-env.mjs'

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function applyRuntimeEnvironment(
  projectRoot = PROJECT_ROOT,
  env = process.env,
  profile,
) {
  const loaded = loadLocalEnv(projectRoot, env)
  const selectedProfile = profile?.trim() || env.FINA_PROFILE?.trim() || 'development'

  const sanitized = { ...env }
  for (const [key, value] of Object.entries(sanitized)) {
    if (isEnvPlaceholder(value)) delete sanitized[key]
  }

  let project
  try {
    project = loadProject(projectRoot, selectedProfile)
  } catch {
    // The sidecar wrappers still work from a standalone checkout fragment as
    // long as `.env` supplied the values they need.
    return { project: null, loaded }
  }

  const runtime = buildRuntimeEnvironment(project, sanitized)
  for (const [key, value] of Object.entries(runtime)) {
    if (env[key] === undefined || env[key] === '' || isEnvPlaceholder(env[key])) env[key] = value
  }
  return { project, loaded }
}
