import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'

const mode = process.argv[2] ?? 'dev'
if (!['dev', 'build'].includes(mode)) {
  console.error(`Usage: node scripts/tauri-cuda.mjs <dev|build> [...tauri args]`)
  process.exit(2)
}

const tauriBin = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
)

// RTX 3060 Ti is compute capability 8.6. Keep this as a build-time default,
// while allowing users with another NVIDIA GPU to override it explicitly:
// CMAKE_CUDA_ARCHITECTURES=89 npm run tauri:build:cuda
const env = {
  ...process.env,
  CMAKE_CUDA_ARCHITECTURES: process.env.CMAKE_CUDA_ARCHITECTURES || '86',
}

/**
 * CMake can otherwise combine /usr/bin/nvcc from one installation with the
 * headers/libraries discovered under /usr/local/cuda-* from another. That
 * produces misleading architecture errors when nvcc invokes a different
 * toolkit's ptxas. Prefer an explicitly configured toolkit, then a CUDA bin
 * directory already present in PATH.
 */
function configureCoherentCudaToolkit() {
  if (env.CUDACXX || env.CMAKE_CUDA_COMPILER) return
  const pathCandidates = (env.PATH || '')
    .split(delimiter)
    .filter((entry) => basename(entry) === 'bin' && basename(dirname(entry)).startsWith('cuda'))
    .map((entry) => dirname(entry))
  const roots = [env.CUDA_PATH, env.CUDA_HOME, ...pathCandidates, '/usr/local/cuda']
  const root = roots.find((candidate) => candidate && existsSync(join(candidate, 'bin', 'nvcc')))
  if (!root) return
  const nvcc = join(root, 'bin', 'nvcc')
  env.CUDA_PATH ||= root
  env.CUDACXX = nvcc
  env.CMAKE_CUDA_COMPILER = nvcc
  env.PATH = `${join(root, 'bin')}${delimiter}${env.PATH || ''}`
}

configureCoherentCudaToolkit()

/**
 * A failed CMake configure can leave CMakeCache.txt behind without producing
 * a Makefile/build.ninja. The cmake crate then incorrectly treats that output
 * as configured and fails with "No rule to make target 'Makefile'" on every
 * retry. Remove only this invalid llama.cpp subdirectory; keep Cargo's normal
 * dependency cache and all unrelated build artifacts intact.
 */
function removeStaleLlamaBuilds() {
  const targetRoot = process.env.CARGO_TARGET_DIR || join(process.cwd(), 'target')
  for (const profile of ['debug', 'release']) {
    const buildRoot = join(targetRoot, profile, 'build')
    if (!existsSync(buildRoot)) continue
    for (const entry of readdirSync(buildRoot)) {
      if (!entry.startsWith('llama-cpp-sys-2-')) continue
      const cmakeBuild = join(buildRoot, entry, 'out', 'build')
      if (!existsSync(cmakeBuild)) continue
      const hasBuildSystem = existsSync(join(cmakeBuild, 'Makefile')) || existsSync(join(cmakeBuild, 'build.ninja'))
      if (!hasBuildSystem) rmSync(cmakeBuild, { recursive: true, force: true })
    }
  }
}

removeStaleLlamaBuilds()

const result = spawnSync(tauriBin, [mode, '--features', 'cuda', ...process.argv.slice(3)], {
  env,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`Could not start Tauri CLI: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
