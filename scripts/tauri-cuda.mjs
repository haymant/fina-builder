import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

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

const result = spawnSync(tauriBin, [mode, '--features', 'cuda', ...process.argv.slice(3)], {
  env,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`Could not start Tauri CLI: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
