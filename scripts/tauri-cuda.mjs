import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const targetRoot = process.env.CARGO_TARGET_DIR || join(process.cwd(), 'target')

// ---------------------------------------------------------------------------
// glibc >= 2.41 vs CUDA header clash
//
// bits/libc-header-start.h enables the C23 IEC 60559 math functions whenever
// `__USE_GNU` is set, and g++ always defines `_GNU_SOURCE`. glibc therefore
// declares `rsqrt`/`rsqrtf` with `__THROW`, i.e. `noexcept (true)`, while CUDA's
// crt/math_functions.h declares the same names as device builtins with no
// exception specification at all. A second declaration with an incompatible
// exception specification is ill-formed, so *any* .cu file that pulls in both
// headers fails:
//
//   bits/mathcalls.h(206): error: exception specification is incompatible with
//   that of previous function "rsqrt"
//
// That breaks CMake's enable_language(CUDA) compiler-ID probe, so the build dies
// before llama.cpp is even reached -- the target directory and the CUDA
// architecture are irrelevant. No released toolkit avoids it: 12.6 fails on
// cospi, 13.x on rsqrt. -U_GNU_SOURCE only trades it for libstdc++ errors, since
// c++locale.h and <mutex> need _GNU_SOURCE for uselocale and pthread_*_clock*.
//
// The fix is to give CUDA's declarations the exception specification glibc
// expects. The toolkit is root-owned, so we shadow its include tree instead of
// editing it: nvcc resolves <cuda_runtime.h> out of -I paths before its built-in
// ones, and every quoted include inside the shadowed copy stays within that copy.
// The toolkit itself is left untouched.
//
// The offending symbols are discovered by compiling a probe and reading the
// compiler's own diagnostics, so this adapts to whichever toolkit is installed
// rather than hard-coding a list.
// ---------------------------------------------------------------------------

function cudaIncludeDir(root) {
  const hostTriple = `${process.arch === 'x64' ? 'x86_64' : process.arch}-linux`
  const candidates = [join(root, 'targets', hostTriple, 'include'), join(root, 'include')]
  const targets = join(root, 'targets')
  if (existsSync(targets)) {
    for (const entry of readdirSync(targets)) {
      candidates.push(join(targets, entry, 'include'))
    }
  }
  return candidates.find((dir) => existsSync(join(dir, 'crt', 'math_functions.h')))
}

function conflictingSymbols(nvcc, includeDir) {
  const probeDir = join(targetRoot, 'cuda-header-probe')
  const source = join(probeDir, 'probe.cu')
  mkdirSync(probeDir, { recursive: true })
  // Mirrors the real ggml-cuda sources: device builtins, <cmath>, and the
  // libstdc++ headers that need _GNU_SOURCE.
  writeFileSync(
    source,
    [
      '#include <cuda_runtime.h>',
      '#include <cmath>',
      '#include <mutex>',
      '#include <locale>',
      '__global__ void k(float* p) {',
      '  p[threadIdx.x] = rsqrtf(p[threadIdx.x]) + std::sqrt(2.0f) + rsqrt((double)p[threadIdx.x]);',
      '}',
      'int main() { std::mutex m; std::locale l("C"); (void)m; (void)l; return 0; }',
      '',
    ].join('\n'),
  )
  const args = ['-c', source, '-o', join(probeDir, 'probe.o')]
  if (includeDir) args.unshift(`-I${includeDir}`)
  const probe = spawnSync(nvcc, args, { encoding: 'utf8' })
  if (probe.status === 0) return []
  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
  const symbols = new Set(
    [...output.matchAll(/previous function "([A-Za-z_][A-Za-z0-9_]*)"/g)].map((match) => match[1]),
  )
  if (symbols.size === 0) {
    console.error(`Could not compile the CUDA header probe with ${nvcc}:\n${output.trim()}`)
    process.exit(1)
  }
  return [...symbols].sort()
}

/**
 * Add glibc's `noexcept (true)` to CUDA's declarations of `symbol`. Only
 * `extern` declarations are rewritten, so call sites and macro bodies such as
 * `return rsqrtf(a);` are left alone.
 */
function addNoexcept(shimInclude, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declaration = new RegExp(`^(\\s*extern\\b.*?\\b${escaped}\\s*\\()(.*?)(\\)\\s*;)\\s*$`)
  let patched = 0
  for (const entry of readdirSync(join(shimInclude, 'crt'))) {
    if (!entry.endsWith('.h') && !entry.endsWith('.hpp')) continue
    const file = join(shimInclude, 'crt', entry)
    const lines = readFileSync(file, 'utf8').split('\n')
    let changed = false
    for (let i = 0; i < lines.length; i += 1) {
      const match = declaration.exec(lines[i])
      if (!match) continue
      lines[i] = `${match[1]}${match[2]}) noexcept(true);`
      changed = true
      patched += 1
    }
    if (changed) writeFileSync(file, lines.join('\n'))
  }
  return patched
}

// Flags that must reach every CUDA compile. CMake seeds CMAKE_CUDA_FLAGS from the
// CUDAFLAGS environment variable, so this is the only injection point that works.
const requiredCudaFlags = []

function addCudaFlags(...flags) {
  for (const flag of flags) {
    if (requiredCudaFlags.includes(flag)) continue
    requiredCudaFlags.push(flag)
    env.CUDAFLAGS = `${env.CUDAFLAGS ?? ''} ${flag}`.trim()
  }
}

/**
 * ggml is built as a static archive (BUILD_SHARED_LIBS=OFF) that is linked into
 * Tauri's cdylib, so its objects must be position independent. llama-cpp-sys-2
 * passes -fPIC in CMAKE_C_FLAGS/CMAKE_CXX_FLAGS but never configures
 * CMAKE_CUDA_FLAGS, so the CUDA objects come out non-PIC and the final link fails:
 *
 *   rust-lld: error: relocation R_X86_64_PC32 cannot be used against symbol
 *   'stderr'; recompile with -fPIC
 *
 * nvcc rejects a bare -fPIC ("Unknown option"), so the flag has to be forwarded
 * to the host compiler explicitly.
 */
function applyPositionIndependentCode() {
  if (process.platform !== 'linux') return
  addCudaFlags('-Xcompiler', '-fPIC')
}

applyPositionIndependentCode()

function shimLayout(nvcc, root) {
  const source = cudaIncludeDir(root)
  if (!source) return null
  const version = spawnSync(nvcc, ['--version'], { encoding: 'utf8' }).stdout?.match(/release ([\d.]+)/)?.[1]
  const shimRoot = join(targetRoot, 'cuda-header-shim', `${basename(root)}-${version ?? 'unknown'}`)
  return { source, shimRoot, shimInclude: join(shimRoot, 'include'), marker: join(shimRoot, 'patched.json') }
}

function buildCudaHeaderShim(nvcc, layout) {
  const { source, shimRoot, shimInclude, marker } = layout
  console.log(`Preparing a CUDA header shim for glibc (${basename(shimRoot)})`)
  rmSync(shimRoot, { recursive: true, force: true })
  mkdirSync(shimRoot, { recursive: true })
  cpSync(source, shimInclude, { recursive: true })

  // Each round can expose further symbols, so keep patching until the probe is clean.
  const patched = []
  for (let round = 0; round < 16; round += 1) {
    const symbols = conflictingSymbols(nvcc, shimInclude)
    if (symbols.length === 0) {
      writeFileSync(marker, JSON.stringify({ source, patched }, null, 2))
      console.log(`CUDA header shim ready: ${patched.join(', ')}`)
      return shimInclude
    }
    for (const symbol of symbols) {
      const sites = addNoexcept(shimInclude, symbol)
      if (sites > 0) {
        patched.push(`${symbol} (${sites})`)
      } else {
        console.error(`Could not find a CUDA declaration to patch for "${symbol}".`)
        process.exit(1)
      }
    }
  }
  console.error(`CUDA header shim did not converge after 16 rounds: ${patched.join(', ')}`)
  process.exit(1)
}

/**
 * CMake only passes the CUDAFLAGS environment variable to the compiler-ID probe
 * that enable_language(CUDA) runs; a CMAKE_CUDA_FLAGS environment variable
 * arrives after that step and cannot rescue the probe. So the shim has to be
 * injected here.
 */
function applyCudaHeaderShim() {
  if (process.platform !== 'linux') return
  if (process.env.FINA_CUDA_HEADER_SHIM === 'off') return
  const nvcc = env.CUDACXX || env.CMAKE_CUDA_COMPILER
  const root = env.CUDA_PATH || env.CUDA_HOME
  if (!nvcc || !root) return
  const layout = shimLayout(nvcc, root)
  if (!layout) return
  // A cached shim is revalidated rather than rebuilt, so only one probe compiles
  // on the common path.
  const cached =
    existsSync(layout.marker) && conflictingSymbols(nvcc, layout.shimInclude).length === 0
      ? layout.shimInclude
      : null
  if (cached) {
    addCudaFlags(`-I${cached}`)
    return
  }
  if (conflictingSymbols(nvcc, null).length === 0) return
  addCudaFlags(`-I${buildCudaHeaderShim(nvcc, layout)}`)
}

applyCudaHeaderShim()

/**
 * llama-cpp-sys-2 builds with `always_configure(false)`, so an existing CMake
 * cache is reused verbatim and new CUDAFLAGS never reach it. Two failures come
 * from that. A configure interrupted before generating a build system leaves a
 * CMakeCache.txt with no Makefile/build.ninja, and every retry then dies with
 * "No rule to make target 'Makefile'". Separately, a cache recorded before a flag
 * was added keeps compiling with the stale value, which is how a non-PIC
 * ggml-cuda archive survives into the final link.
 *
 * Deleting the CMake tree is not sufficient on its own: Cargo's fingerprint for
 * the build script still matches, so the script is skipped entirely and the old
 * archive is handed to the linker unchanged. Removing the fingerprint as well is
 * what makes the build script re-run with the flags just computed.
 *
 * `cargo clean -p llama-cpp-sys-2` is not used here because it does not reliably
 * match every feature variant of the package (the cuda and non-cuda builds have
 * different metadata hashes), and it leaves the stale archive behind. Removing
 * the package's own directories is deterministic; every unrelated artifact in
 * target/ stays in place.
 */
const LLAMA_SYS = 'llama-cpp-sys-2'

function removeLlamaSysArtifacts(profile) {
  const profileRoot = join(targetRoot, profile)
  const prefixed = [LLAMA_SYS, `lib${LLAMA_SYS.replace(/-/g, '_')}-`]
  for (const dir of ['build', 'deps', '.fingerprint']) {
    const root = join(profileRoot, dir)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      if (!prefixed.some((prefix) => entry.startsWith(prefix))) continue
      rmSync(join(root, entry), { recursive: true, force: true })
    }
  }
}

/**
 * A profile needs rebuilding when it holds a prebuilt llama-cpp-sys-2 archive that
 * no valid, up-to-date CMake tree backs. That covers three cases: a tree with no
 * build system, a tree whose cache predates a required flag, and the case that is
 * easiest to miss -- artifacts exist but the CMake tree is gone entirely, which
 * is what a previous reset leaves behind and what makes the stale archive get
 * linked again.
 */
function staleReason(profile) {
  const profileRoot = join(targetRoot, profile)
  const depsRoot = join(profileRoot, 'deps')
  const hasArtifacts =
    existsSync(depsRoot) &&
    readdirSync(depsRoot).some((entry) => entry.startsWith(`lib${LLAMA_SYS.replace(/-/g, '_')}-`))

  const buildRoot = join(profileRoot, 'build')
  const trees = (existsSync(buildRoot) ? readdirSync(buildRoot) : [])
    .filter((entry) => entry.startsWith(`${LLAMA_SYS}-`))
    .map((entry) => join(buildRoot, entry, 'out', 'build'))
    .filter((dir) => existsSync(dir))

  if (trees.length === 0) return hasArtifacts ? 'archive without a CMake tree' : null
  for (const tree of trees) {
    const hasBuildSystem =
      existsSync(join(tree, 'Makefile')) || existsSync(join(tree, 'build.ninja'))
    if (!hasBuildSystem) return 'half-configured CMake tree'
    const cache = readFileSync(join(tree, 'CMakeCache.txt'), 'utf8')
    const cudaFlags = cache.match(/^CMAKE_CUDA_FLAGS:STRING=(.*)$/m)?.[1] ?? ''
    const missing = requiredCudaFlags.filter((flag) => !cudaFlags.includes(flag))
    if (missing.length > 0) return `CMake cache missing ${missing.join(' ')}`
  }
  return null
}

function resetStaleLlamaCpp() {
  const stale = []
  for (const profile of ['debug', 'release']) {
    const reason = staleReason(profile)
    if (reason) stale.push([profile, reason])
  }
  if (stale.length === 0) return
  for (const [profile, reason] of stale) {
    console.log(`Rebuilding llama.cpp for ${profile}: ${reason}`)
    removeLlamaSysArtifacts(profile)
  }
}

resetStaleLlamaCpp()

const result = spawnSync(tauriBin, [mode, '--features', 'cuda', ...process.argv.slice(3)], {
  env,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`Could not start Tauri CLI: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
