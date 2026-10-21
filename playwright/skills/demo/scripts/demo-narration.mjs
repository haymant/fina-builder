#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * Curated narrator voices for fina-builder demo recordings.
 * One voice per video; Andrew is the default.
 */
const VOICES = {
  andrew: {
    id: 'en-US-AndrewNeural',
    label: 'Andrew',
    accent: 'US',
    character: 'warm, confident, conversational',
  },
  steffan: {
    id: 'en-US-SteffanNeural',
    label: 'Steffan',
    accent: 'US',
    character: 'neutral broadcast news',
  },
  thomas: {
    id: 'en-GB-ThomasNeural',
    label: 'Thomas',
    accent: 'UK',
    character: 'friendly, conversational',
  },
  eric: {
    id: 'en-US-EricNeural',
    label: 'Eric',
    accent: 'US',
    character: 'measured, analytical',
  },
}

const DEFAULT_VOICE = 'andrew'
const DEFAULT_RATE = '+0%'
const DEFAULT_PITCH = '+0Hz'

function usage() {
  console.log(`Usage: npm run demo:narrate -- --script <cues.txt> [options]

Generates one MP3 per narration cue with a curated male narrator.

Cue file: one cue per line; blank lines and lines starting with # are ignored.

Options:
  --script <path>   Cue script (required)
  --out <dir>       Output directory (default: playwright/recordings/demo-narration)
  --voice <key>     Narrator: ${Object.keys(VOICES).join(', ')} (default: ${DEFAULT_VOICE})
  --rate <value>    edge-tts rate, e.g. +10% (default: ${DEFAULT_RATE})
  --pitch <value>   edge-tts pitch, e.g. +0Hz (default: ${DEFAULT_PITCH})
  --list            List available narrators and exit
  --help            Show this help

Environment:
  DEMO_NARRATION_VOICE   Default narrator when --voice is omitted
  EDGE_TTS_BIN           edge-tts executable (default: edge-tts)

Install edge-tts once:
  python3 -m venv .venv-tts && .venv-tts/bin/pip install edge-tts
  export EDGE_TTS_BIN="$PWD/.venv-tts/bin/edge-tts"
`)
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}

function parseArgs(argv) {
  const args = { voice: process.env.DEMO_NARRATION_VOICE ?? DEFAULT_VOICE, rate: DEFAULT_RATE, pitch: DEFAULT_PITCH }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { ...args, help: true }
    if (arg === '--list') return { ...args, list: true }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const value = argv[i + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    const key = arg.slice(2)
    if (!['script', 'out', 'voice', 'rate', 'pitch'].includes(key)) {
      throw new Error(`Unknown option: ${arg}`)
    }
    args[key] = value
    i += 1
  }
  return args
}

function readCues(path) {
  const text = readFileSync(path, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function measureDuration(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) return null
  const duration = Number.parseFloat(result.stdout.trim())
  return Number.isFinite(duration) ? Number(duration.toFixed(3)) : null
}

function synthesize(cue, file, { bin, voice, rate, pitch }) {
  const result = spawnSync(
    bin,
    ['--voice', voice.id, '--rate', rate, '--pitch', pitch, '--text', cue, '--write-media', file],
    { stdio: 'inherit' },
  )
  if (result.error) {
    throw new Error(`Unable to run ${bin}: ${result.error.message}\nSet EDGE_TTS_BIN or install edge-tts.`)
  }
  if (result.status !== 0) throw new Error(`edge-tts exited with status ${result.status} for cue: ${cue}`)
}

function listVoices() {
  for (const [key, voice] of Object.entries(VOICES)) {
    console.log(`${key.padEnd(8)} ${voice.id.padEnd(28)} ${voice.accent.padEnd(3)} ${voice.character}`)
  }
  console.log(`\nDefault: ${DEFAULT_VOICE}`)
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
    usage()
    return
  }

  if (args.help) return usage()
  if (args.list) return listVoices()

  if (!args.script) {
    fail('Missing required --script <cues.txt>')
    usage()
    return
  }

  const voiceKey = String(args.voice).toLowerCase()
  const voice = VOICES[voiceKey]
  if (!voice) {
    fail(`Unknown narrator "${args.voice}". Choose one of: ${Object.keys(VOICES).join(', ')}`)
    return
  }

  const scriptPath = resolve(args.script)
  let cues
  try {
    cues = readCues(scriptPath)
  } catch (error) {
    fail(`Unable to read ${scriptPath}: ${error.message}`)
    return
  }
  if (cues.length === 0) {
    fail(`No cues found in ${scriptPath}`)
    return
  }

  const outDir = resolve(args.out ?? join(REPO_ROOT, 'playwright', 'recordings', 'demo-narration'))
  mkdirSync(outDir, { recursive: true })

  const bin = process.env.EDGE_TTS_BIN || 'edge-tts'
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  if (version.error) {
    fail(`Unable to run ${bin}: ${version.error.message}\nInstall edge-tts or set EDGE_TTS_BIN.`)
    return
  }

  console.log(`Narrator: ${voice.label} (${voice.id}) — ${voice.character}`)
  console.log(`Script:   ${basename(scriptPath)} (${cues.length} cues)`)
  console.log(`Output:   ${outDir}\n`)

  const width = Math.max(2, String(cues.length).length)
  const manifest = {
    voice: voiceKey,
    voiceId: voice.id,
    rate: args.rate,
    pitch: args.pitch,
    script: basename(scriptPath),
    cues: [],
  }

  for (const [index, cue] of cues.entries()) {
    const name = `cue-${String(index + 1).padStart(width, '0')}.mp3`
    const file = join(outDir, name)
    try {
      synthesize(cue, file, { bin, voice, rate: args.rate, pitch: args.pitch })
    } catch (error) {
      fail(error.message)
      return
    }
    const durationSeconds = measureDuration(file)
    manifest.cues.push({ index: index + 1, text: cue, file: name, durationSeconds })
    const duration = durationSeconds === null ? '   ?   ' : `${durationSeconds.toFixed(2)}s`.padStart(7)
    console.log(`${String(index + 1).padStart(width)} ${duration}  ${name}  ${cue}`)
  }

  const manifestPath = join(outDir, 'narration.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`\nWrote ${manifestPath}`)
}

main()
