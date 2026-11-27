/**
 * Apply the control-plane runtime environment to a launcher's `process.env`.
 *
 * The desktop host, `dev:http`, and sidecar wrappers use the same dotenv order
 * and profile defaults. Explicit process values win; only a profile-injected
 * lake default can be replaced by a local `.env` value.
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
  options = {},
) {
  const selectedProfile = profile?.trim() || env.FINA_PROFILE?.trim() || 'development'

  let project
  try {
    project = loadProject(projectRoot, selectedProfile)
  } catch {
    // Sidecar wrappers may be invoked from a source fragment without fina.toml;
    // retain dotenv-only behavior there for explicitly configured values.
    const loaded = loadLocalEnv(projectRoot, env, options)
    return { project: null, loaded }
  }

  // Mark only absent/placeholder values as replaceable profile defaults.
  // Existing process values stay explicit even when equal to a profile path.
  if (env.TAC_LAKE_DIR === undefined || env.TAC_LAKE_DIR === '' || isEnvPlaceholder(env.TAC_LAKE_DIR)) {
    env.FINA_PROFILE_TAC_LAKE_DIR = project.paths.tac_lake
  }
  if (env.NIP_LAKE_DIR === undefined || env.NIP_LAKE_DIR === '' || isEnvPlaceholder(env.NIP_LAKE_DIR)) {
    env.FINA_PROFILE_NIP_LAKE_DIR = project.paths.nip_lake
  }
  const loaded = loadLocalEnv(project.root, env, options)

  const sanitized = { ...env }
  for (const [key, value] of Object.entries(sanitized)) {
    if (isEnvPlaceholder(value)) delete sanitized[key]
  }

  const runtime = buildRuntimeEnvironment(project, sanitized)
  for (const [key, value] of Object.entries(runtime)) {
    if (key === 'NIP_LAKE_DIR' || key === 'NIP_DATA_DIR' || key === 'TAC_LAKE_DIR'
      || key === 'FINA_PROFILE_NIP_LAKE_DIR' || key === 'FINA_PROFILE_TAC_LAKE_DIR') {
      env[key] = value
    } else if (env[key] === undefined || env[key] === '' || isEnvPlaceholder(env[key])) {
      env[key] = value
    }
  }
  return { project, loaded }
}
