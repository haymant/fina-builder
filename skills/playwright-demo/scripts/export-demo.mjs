#!/usr/bin/env node
/**
 * Build a narrated demo MP4 from a Playwright WebM and a cue timeline.
 *
 * The Playwright `demo` fixture writes `demo-timeline.json` next to the video.
 * Each cue line in the script is matched to one timeline beat, synthesized with
 * edge-tts, placed at the beat timestamp, mixed into a WAV master, and muxed
 * with the recording. The script refuses to finish on a silent or stream-broken
 * MP4, so a demo cannot be published without narrative audio by accident.
 *
 * Usage:
 *   node skills/playwright-demo/scripts/export-demo.mjs \
 *     --video playwright/test-results/<run>/video.webm \
 *     --timeline playwright/test-results/<run>/demo-timeline.json \
 *     --cues skills/playwright-demo/cues/narrative-intelligence.txt \
 *     --out artifacts/demo/narrative-intelligence-final.mp4
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const NARRATOR = join(REPO_ROOT, 'playwright', 'skills', 'demo', 'scripts', 'demo-narration.mjs')

function usage() {
  console.log(`Usage: node skills/playwright-demo/scripts/export-demo.mjs --video <video.webm> --cues <cues.txt> [options]

Options:
  --video <path>       Playwright recording (required)
  --timeline <path>    demo-timeline.json written by the demo fixture (required)
  --cues <path>        One narration line per demo step (required)
  --out <path>         Final MP4 (default: artifacts/demo/demo-final.mp4)
  --work-dir <path>    Intermediate audio/master files (default: sibling of --out)
  --title-card <mp4>   Optional title clip prepended before the recording
  --voice <key>        Narrator: andrew, steffan, thomas, eric (default: andrew)
  --rate <value>       edge-tts rate (default: +0%)
  --pitch <value>      edge-tts pitch (default: +0Hz)
  --lead-ms <n>        Extra delay before the first cue (default: 250)
  --force              Re-synthesize narration clips
  --no-synthesize      Reuse an existing narration.json + clips
  --help               Show this help

Install the narrator once:
  python3 -m venv .venv-tts && .venv-tts/bin/pip install edge-tts
  export EDGE_TTS_BIN="$PWD/.venv-tts/bin/edge-tts"
`)
}

function fail(message) {
  console.error(`\n[export-demo] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = {
    voice: process.env.DEMO_NARRATION_VOICE ?? 'andrew',
    rate: '+0%',
    pitch: '+0Hz',
    leadMs: 250,
    out: join(REPO_ROOT, 'artifacts', 'demo', 'demo-final.mp4'),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { ...args, help: true }
    if (arg === '--force') {
      args.force = true
      continue
    }
    if (arg === '--no-synthesize') {
      args.noSynthesize = true
      continue
    }
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`)
    const value = argv[i + 1]
    if (!value) fail(`Missing value for ${arg}`)
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (!['video', 'timeline', 'cues', 'out', 'workDir', 'titleCard', 'voice', 'rate', 'pitch', 'leadMs'].includes(key)) {
      fail(`Unknown option: ${arg}`)
    }
    args[key] = key === 'leadMs' ? Number.parseInt(value, 10) : value
    i += 1
  }
  return args
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) fail(`Unable to run ${command}: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? `${result.stdout ?? ''}\n${result.stderr ?? ''}` : ''
    fail(`${command} exited with status ${result.status}\n${detail}`)
  }
  return result
}

function probe(file) {
  const result = run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,codec_name,width,height,sample_rate,channels,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    file,
  ], { capture: true })
  return JSON.parse(result.stdout)
}

function readCues(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function readTimeline(path) {
  const payload = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(payload.beats) || payload.beats.length === 0) {
    fail(`${path} has no beats; keep demo.step() in the recorded spec.`)
  }
  return payload.beats
    .filter((beat) => Number.isFinite(beat.atMs))
    .sort((left, right) => left.atMs - right.atMs)
}

function readNarration(path) {
  if (!existsSync(path)) fail(`Missing narration manifest: ${path}`)
  const payload = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(payload.cues) || payload.cues.length === 0) fail(`${path} has no cues`)
  return payload
}

function audioLevels(file) {
  const result = run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
    capture: true,
    allowFailure: true,
  })
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
  const read = (name) => {
    const match = text.match(new RegExp(`${name}:\\s*(-?[0-9.]+) dB`))
    return match ? Number.parseFloat(match[1]) : null
  }
  return { mean: read('mean_volume'), max: read('max_volume') }
}

function synthesize(args, workDir) {
  const narrationDir = join(workDir, 'narration')
  mkdirSync(narrationDir, { recursive: true })
  run(process.execPath, [
    NARRATOR,
    '--script', resolve(args.cues),
    '--out', narrationDir,
    '--voice', args.voice,
    '--rate', args.rate,
    '--pitch', args.pitch,
  ])
  return readNarration(join(narrationDir, 'narration.json'))
}

function buildMaster({ cues, beats, narration, duration, workDir, leadMs }) {
  const count = cues.length
  if (beats.length !== count) {
    fail(
      `The timeline has ${beats.length} beats but the cue script has ${count} lines. ` +
        'Keep one demo.step() per narration line, or pass a timeline that matches the script.',
    )
  }

  const starts = beats.map((beat, index) => Math.max(0, beat.atMs + leadMs))
  const gaps = starts.map((start, index) => (index === 0 ? start : start - starts[index - 1]))
  const overlaps = []
  for (let i = 0; i < count; i += 1) {
    const clipDuration = narration.cues[i]?.durationSeconds
    const nextStart = i + 1 < count ? starts[i + 1] : duration * 1000
    // Fail only on real overlap; a clip may end exactly on the next beat.
    if (Number.isFinite(clipDuration) && clipDuration * 1000 > nextStart - starts[i] + 50) {
      overlaps.push(
        `cue ${i + 1} (${clipDuration.toFixed(2)}s) runs into cue ${i + 2 > count ? 'end' : i + 2} ` +
          `(${((nextStart - starts[i]) / 1000).toFixed(2)}s available)`,
      )
    }
  }
  if (overlaps.length) {
    fail(`Narration overlaps the next beat. Tighten the copy or extend the demo holds:\n- ${overlaps.join('\n- ')}`)
  }

  const inputs = []
  for (const cue of narration.cues) inputs.push('-i', join(workDir, 'narration', cue.file))

  const filters = narration.cues.map((cue, index) => `[${index}:a]adelay=${Math.round(starts[index])}:all=1[c${index}]`)
  const mixInputs = narration.cues.map((_, index) => `[c${index}]`).join('')
  const filter = `${filters.join(';')};${mixInputs}amix=inputs=${count}:duration=longest:normalize=0,apad,atrim=duration=${duration.toFixed(3)}[aout]`

  const master = join(workDir, 'narration-master.wav')
  run('ffmpeg', [
    '-y',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[aout]',
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'pcm_s16le',
    master,
  ])
  return { master, starts, gaps }
}

function videoOnly(video, titleCard, workDir) {
  if (!titleCard) return video
  if (!existsSync(titleCard)) fail(`Title card not found: ${titleCard}`)
  const staged = join(workDir, 'video-with-title.mp4')
  run('ffmpeg', [
    '-y',
    '-i', titleCard,
    '-i', video,
    '-filter_complex',
    '[0:v]scale=1280:720:flags=lanczos,setsar=1,fps=30[v0];' +
      '[1:v]scale=1280:720:flags=lanczos,setsar=1,fps=30[v1];' +
      '[v0][v1]concat=n=2:v=1:a=0[v]',
    '-map', '[v]',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    staged,
  ])
  return staged
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()
  for (const required of ['video', 'timeline', 'cues']) {
    if (!args[required]) fail(`Missing required --${required}`)
  }
  if (!existsSync(args.video)) fail(`Video not found: ${args.video}`)
  if (!existsSync(args.timeline)) fail(`Timeline not found: ${args.timeline}`)
  if (!existsSync(args.cues)) fail(`Cue script not found: ${args.cues}`)
  if (!Number.isFinite(args.leadMs) || args.leadMs < 0) fail('--lead-ms must be a non-negative number')

  const out = resolve(args.out)
  const workDir = resolve(args.workDir ?? dirname(out))
  mkdirSync(workDir, { recursive: true })

  const cues = readCues(args.cues)
  const beats = readTimeline(args.timeline)
  if (cues.length === 0) fail('The cue script has no narration lines')

  console.log(`[export-demo] ${cues.length} cues · ${beats.length} beats · voice ${args.voice}`)
  let narration
  if (args.noSynthesize) {
    narration = readNarration(join(workDir, 'narration', 'narration.json'))
  } else {
    narration = synthesize(args, workDir)
  }
  if (narration.cues.length !== cues.length) {
    fail(`Narration has ${narration.cues.length} clips but the cue script has ${cues.length} lines`)
  }

  const videoProbe = probe(args.video)
  const videoDuration = Number.parseFloat(videoProbe.format?.duration)
  if (!Number.isFinite(videoDuration) || videoDuration < 2) fail('Could not read the recording duration')

  let titleDuration = 0
  let baseVideo = args.video
  if (args.titleCard) {
    titleDuration = Number.parseFloat(probe(args.titleCard).format?.duration ?? '0')
    baseVideo = videoOnly(args.video, args.titleCard, workDir)
  }
  const totalDuration = videoDuration + titleDuration

  const { master, starts } = buildMaster({
    cues,
    beats,
    narration,
    duration: totalDuration,
    workDir,
    leadMs: args.leadMs + Math.round(titleDuration * 1000),
  })

  const levels = audioLevels(master)
  if (levels.mean === null || levels.max === null || levels.max < -45) {
    fail(`Narration master is silent (mean ${levels.mean} dB, max ${levels.max} dB)`)
  }
  if (levels.max > -0.1) console.warn(`[export-demo] warning: master peaks at ${levels.max} dBFS`)

  run('ffmpeg', [
    '-y',
    '-i', baseVideo,
    '-i', master,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-t', totalDuration.toFixed(3),
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-movflags', '+faststart',
    out,
  ])

  const final = probe(out)
  const streams = final.streams ?? []
  const video = streams.find((stream) => stream.codec_type === 'video')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  if (!video || !audio) fail('Final MP4 must contain exactly one video and one audio stream')
  if (video.codec_name !== 'h264') fail(`Expected H.264 video, found ${video.codec_name}`)
  if (video.width !== 1280 || video.height !== 720) fail(`Expected 1280x720, found ${video.width}x${video.height}`)
  if (audio.codec_name !== 'aac') fail(`Expected AAC audio, found ${audio.codec_name}`)
  if (audio.channels !== 2) fail(`Expected stereo narration, found ${audio.channels} channel(s)`)
  const finalDuration = Number.parseFloat(final.format?.duration ?? '0')
  if (Math.abs(finalDuration - totalDuration) > 0.5) {
    fail(`Final duration ${finalDuration.toFixed(2)}s differs from the ${totalDuration.toFixed(2)}s recording`)
  }

  const finalLevels = audioLevels(out)
  if (finalLevels.mean === null || finalLevels.max === null || finalLevels.max < -45) {
    fail(`Final MP4 has no audible narration (mean ${finalLevels.mean} dB, max ${finalLevels.max} dB)`)
  }

  const report = {
    video: resolve(args.video),
    titleCard: args.titleCard ? resolve(args.titleCard) : null,
    cues: resolve(args.cues),
    timeline: resolve(args.timeline),
    voice: narration.voice,
    voiceId: narration.voiceId,
    cueStartsMs: starts.map((start) => Math.round(start)),
    cueLabels: beats.map((beat) => beat.label),
    durationSeconds: finalDuration,
    streams: { video, audio },
    audioLevels: finalLevels,
    output: out,
  }
  const reportPath = join(workDir, 'export-report.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  console.log(`\n[export-demo] wrote ${out}`)
  console.log(`[export-demo] ${video.codec_name} ${video.width}x${video.height} · ${audio.codec_name} ${audio.channels}ch · ${finalDuration.toFixed(2)}s`)
  console.log(`[export-demo] narration ${finalLevels.mean} dB mean / ${finalLevels.max} dB peak`)
  console.log(`[export-demo] report ${reportPath}`)
}

main()
