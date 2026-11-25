import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AsrWord } from './asr'
import { startsNumberedStep, type NarrationChunk } from './chunks'
import { NARRATION_GAP_MS } from '../../shared/tts/voices'
import { runFfmpeg } from '../ffmpeg/runner'
import { atomicWriteFile } from '../store/fs-utils'

/**
 * Broadcast post-processing (ffmpeg argv are pure builders — unit-tested,
 * then run through the shared runner). Upgrades 3 and 4:
 *
 *  - click-free chunks: ASR-bounded trim with a 25 ms breath buffer,
 *    15 ms fades on both edges, pitch-preserving pacing (atempo);
 *  - deliberate silence pacing between chunks by tag/punctuation;
 *  - a mastering chain (high-pass → tone EQ → compressor → level trim).
 */

/** Breath kept before the first and after the last syllable of a chunk. */
export const BREATH_MS = 25
/** Keep extra trailing audio beyond ASR's often imprecise word endpoint. */
export const TRAILING_BUFFER_MS = 40
/** Anti-click fades on every chunk edge. */
export const EDGE_FADE_SEC = 0.015
/** Uniform stitch format. */
export const STITCH_RATE_HZ = 48_000

/** The fixed broadcast chain (--master; gentle dynamics, TikTok loudness).
 * Denoise runs pre-compression so the compressor doesn't pump the hiss. The
 * compressor threshold sits ABOVE program level (−4 dB): it tames peaks only —
 * measured live, a −14 dB threshold crushed the program's loudness range from
 * 4.2 to 2.6 LU (the opposite of the LRA 5–7 narration target). The limiter
 * owns the true-peak ceiling at −1.4 dBFS, leaving loudnorm linear-mode
 * headroom instead of its dynamics-flattening dynamic fallback. */
export const MASTER_FILTER =
  'highpass=f=85,' +
  'afftdn=nr=12:nf=-28:tn=1,' +
  'equalizer=f=140:t=q:w=1.2:g=2.5,' +
  'equalizer=f=450:t=q:w=1.5:g=-2.5,' +
  'equalizer=f=3200:t=q:w=1.2:g=1.5,' +
  'acompressor=threshold=-4dB:ratio=2.2:attack=10:release=80,' +
  'alimiter=limit=0.851:level=disabled'

/** Integrated loudness tolerance for skipping loudnorm entirely. */
const LOUDNESS_SKIP_TOLERANCE_LU = 0.7

/** Per-chunk vocoder-hiss cleanup, applied before level/fade shaping. */
export const CHUNK_DENOISE_FILTER = 'afftdn=nr=12:nf=-28:tn=1'

/** Gemini supplies clean, styled audio; preserve its pacing and dynamics. */
export const GEMINI_MASTER_FILTER =
  'highpass=f=85,equalizer=f=140:t=q:w=1.2:g=1,' +
  'equalizer=f=450:t=q:w=1.5:g=-1,equalizer=f=3200:t=q:w=1.2:g=1,' +
  'loudnorm=I=-14:LRA=6:TP=-1.5,aformat=sample_fmts=s16'

export interface TrimPlan {
  /** Where to cut the raw synthesis (seconds into the file). */
  startSec: number
  /** How much of the raw synthesis to keep. */
  durationSec: number
  /** Speech bounds inside the kept window (for word-timestamp mapping). */
  speechStartSec: number
  speechEndSec: number
}

/**
 * Trim plan from what the ASR heard: keep `breathMs` around the first/last
 * spoken word so onsets like "Pertama" keep their attack consonant. Falls
 * back to the whole file when the ASR found no words (the chunk will carry
 * a failed status in the report anyway).
 */
export function planTrim(words: AsrWord[], rawDurationSec: number, breathMs = BREATH_MS, extraTrailingMs = 0): TrimPlan {
  const breathSec = breathMs / 1000
  if (words.length === 0 || rawDurationSec <= 0) {
    return { startSec: 0, durationSec: rawDurationSec, speechStartSec: 0, speechEndSec: rawDurationSec }
  }
  const first = words[0]!
  const last = words[words.length - 1]!
  const startSec = Math.max(0, first.start - breathSec)
  const endSec = Math.min(rawDurationSec, last.end + breathSec + (TRAILING_BUFFER_MS + extraTrailingMs) / 1000)
  const durationSec = Math.max(0.05, endSec - startSec)
  return {
    startSec,
    durationSec,
    speechStartSec: Math.max(0, first.start - startSec),
    speechEndSec: Math.max(0, Math.min(durationSec, last.end - startSec))
  }
}

/** Map a raw-synthesis word time into the chunk's final (paced) timeline. */
export function wordTimeInChunk(timeSec: number, trim: TrimPlan, pacing: number): number {
  return Math.max(0, Math.min(trim.durationSec, timeSec - trim.startSec)) / pacing
}

/** Duration of the PCM WAV produced by processChunkWav, using its actual sample count. */
export async function conditionedWavDuration(file: string): Promise<number> {
  const handle = await fs.open(file, 'r')
  try {
    const header = Buffer.alloc(12)
    if ((await handle.read(header, 0, 12, 0)).bytesRead !== 12 ||
        header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Invalid conditioned WAV header')
    }
    const stat = await handle.stat()
    let offset = 12
    const chunk = Buffer.alloc(8)
    while (offset + 8 <= stat.size) {
      if ((await handle.read(chunk, 0, 8, offset)).bytesRead !== 8) break
      const size = chunk.readUInt32LE(4)
      if (chunk.toString('ascii', 0, 4) === 'data') {
        const bytes = Math.min(size, stat.size - offset - 8)
        if (bytes <= 0) throw new Error('Conditioned WAV contains no audio')
        return bytes / (STITCH_RATE_HZ * 2)
      }
      offset += 8 + size + (size % 2)
    }
    throw new Error('Conditioned WAV has no audio data')
  } finally {
    await handle.close()
  }
}

/** argv: raw chunk WAV → trimmed, denoised, level-shaped, faded, 48 kHz mono PCM. */
export function chunkProcessArgs(input: {
  source: string
  output: string
  trim: TrimPlan
  pacing: number
  /** Tag loudness shaping, e.g. +0.5 hook / −1.5 twist. */
  levelDb?: number
  profile?: 'gemini-tts' | 'gemini-cloud'
}): string[] {
  // Cloud synthesis is already clean. ASR timestamps may end before a soft
  // final syllable, so keep the entire source instead of seeking to its words.
  // Reverse twice to fade the actual end, independent of ASR duration rounding.
  if (input.profile === 'gemini-cloud') {
    return [
      '-y', '-i', input.source,
      '-af', `areverse,afade=t=in:st=0:d=${EDGE_FADE_SEC},areverse,adelay=20:all=1,afade=t=in:st=0:d=${EDGE_FADE_SEC},apad=pad_dur=0.02,aresample=${STITCH_RATE_HZ}`,
      '-ac', '1', '-c:a', 'pcm_s16le', input.output
    ]
  }
  const pacedDuration = input.trim.durationSec / (input.profile === 'gemini-tts' ? 1 : input.pacing)
  const fadeOutStart = Math.max(0, pacedDuration - EDGE_FADE_SEC)
  const filters = [
    // Subtle slow-down only (≤3%); audible speed-ups distort timbre.
    ...(input.profile !== 'gemini-tts' && input.pacing !== 1 ? [`atempo=${input.pacing.toFixed(4)}`] : []),
    ...(input.profile === 'gemini-tts' ? [] : [CHUNK_DENOISE_FILTER]),
    ...(input.profile !== 'gemini-tts' && input.levelDb ? [`volume=${input.levelDb.toFixed(1)}dB`] : []),
    `afade=t=in:st=0:d=${EDGE_FADE_SEC}`,
    `afade=t=out:st=${fadeOutStart.toFixed(4)}:d=${EDGE_FADE_SEC}`,
    `aresample=${STITCH_RATE_HZ}`
  ].join(',')
  return [
    '-y',
    '-ss', trimStart(input.trim),
    '-t', input.trim.durationSec.toFixed(4),
    '-i', input.source,
    '-af', filters,
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    input.output
  ]
}

function trimStart(trim: TrimPlan): string {
  return trim.startSec.toFixed(4)
}

/**
 * Deliberate silence after a chunk, from the script's own structure:
 *  - 450 ms before a [twist] reveal (the pre-reveal beat),
 *  - 260 ms at a numbered step or a [tactical] transition,
 *  - 100 ms while inside a [hook] run (tight pacing),
 *  - 160 ms at a plain sentence break.
 */
export function gapMsAfter(current: NarrationChunk, next: NarrationChunk): number {
  if (next.tag === 'hook') return NARRATION_GAP_MS.hook
  if (next.tag === 'twist' && current.tag !== 'twist') return NARRATION_GAP_MS.twistBeat
  if (startsNumberedStep(next.text)) return NARRATION_GAP_MS.step
  if (next.tag === 'tactical' && current.tag !== 'tactical') return NARRATION_GAP_MS.step
  return NARRATION_GAP_MS.sentence
}

/** argv: exact-length digital silence in the stitch format. */
export function silenceArgs(file: string, seconds: number): string[] {
  return [
    '-y',
    '-f', 'lavfi',
    '-i', `anullsrc=r=${STITCH_RATE_HZ}:cl=mono`,
    '-t', seconds.toFixed(4),
    '-c:a', 'pcm_s16le',
    file
  ]
}

/** ffconcat list body for the ordered stitch files. */
export function buildConcatList(files: string[]): string {
  const lines = ['ffconcat version 1.0']
  for (const file of files) lines.push(`file '${file.replace(/'/g, "'\\''")}'`)
  return `${lines.join('\n')}\n`
}

// --- runners -------------------------------------------------------------------

async function run(
  ffmpegPath: string,
  args: string[],
  durationSec: number,
  label: string,
  signal?: AbortSignal
): Promise<void> {
  const result = await runFfmpeg({ ffmpegPath, args, durationSec, signal })
  if (result.cancelled || signal?.aborted) throw new Error('Narration cancelled')
  if (result.stalled) throw new Error(`${label} stalled`)
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stderrTail.slice(-4).join(' ')}`)
}

export async function processChunkWav(options: {
  ffmpegPath: string
  source: string
  output: string
  trim: TrimPlan
  pacing: number
  levelDb?: number
  profile?: 'gemini-tts' | 'gemini-cloud'
  signal?: AbortSignal
}): Promise<void> {
  await run(
    options.ffmpegPath,
    chunkProcessArgs(options),
    Math.max(0.5, options.trim.durationSec + 1),
    'Chunk conditioning',
    options.signal
  )
}

export async function renderGapSilence(options: {
  ffmpegPath: string
  file: string
  seconds: number
  signal?: AbortSignal
}): Promise<void> {
  await run(
    options.ffmpegPath,
    silenceArgs(options.file, options.seconds),
    options.seconds + 0.5,
    'Gap silence',
    options.signal
  )
}

/** Static trim to the TikTok target with a true-peak safety limiter. Linear
 * gain only — loudnorm's dynamic mode is an auto gain rider that flattens
 * narration dynamics (measured live: LRA 4.2 → 2.6). */
export function masterTrimFilter(gainDb: number): string {
  const clamped = Math.max(-6, Math.min(6, gainDb))
  return `volume=${clamped.toFixed(2)}dB,alimiter=limit=0.891:level=disabled`
}

export async function stitchNarration(options: {
  ffmpegPath: string
  files: string[]
  output: string
  master: boolean
  totalDurationSec: number
  signal?: AbortSignal
  profile?: 'gemini-tts'
}): Promise<{ masterFilter: string | null }> {
  const listFile = path.join(
    path.dirname(options.output),
    `.${path.basename(options.output)}.ffconcat.tmp`
  )
  await atomicWriteFile(listFile, buildConcatList(options.files))
  try {
    if (!options.master) {
      await run(
        options.ffmpegPath,
        ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '2', options.output],
        Math.max(1, options.totalDurationSec + 5),
        'Narration stitch',
        options.signal
      )
      return { masterFilter: null }
    }

    if (options.profile === 'gemini-tts') {
      await run(options.ffmpegPath,
        ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-af', GEMINI_MASTER_FILTER,
          '-ar', String(STITCH_RATE_HZ), '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '2', options.output],
        Math.max(1, options.totalDurationSec + 5), 'Narration mastering', options.signal)
      return { masterFilter: GEMINI_MASTER_FILTER }
    }

    // Master pass 1: chain (no loudnorm) → measure. If integrated loudness
    // already lands in tolerance, the chain IS the master — running loudnorm
    // here would only engage its dynamic fallback and flatten the narration.
    const staged = options.output.replace(/\.(mp3)$/i, '.master.wav')
    await run(
      options.ffmpegPath,
      ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-af', MASTER_FILTER, '-ar', String(STITCH_RATE_HZ), '-ac', '1', '-c:a', 'pcm_s16le', staged],
      Math.max(1, options.totalDurationSec + 5),
      'Narration mastering',
      options.signal
    )
    const measured = await measureAudioMetrics(options.ffmpegPath, staged, options.signal)
    const loudnessOk =
      measured.integratedLufs !== null &&
      Math.abs(measured.integratedLufs - (-14)) <= LOUDNESS_SKIP_TOLERANCE_LU

    let masterFilter = MASTER_FILTER
    if (loudnessOk) {
      // Encode the measured master as-is.
      await run(
        options.ffmpegPath,
        ['-y', '-i', staged, '-c:a', 'libmp3lame', '-q:a', '2', options.output],
        Math.max(1, options.totalDurationSec + 5),
        'Narration mastering',
        options.signal
      )
    } else {
      // Out of tolerance: static trim to −14 LUFS (linear gain + peak
      // limiter) — dynamics pass through untouched.
      const gainDb = -14 - (measured.integratedLufs ?? -14)
      masterFilter = `${masterFilter},${masterTrimFilter(gainDb)}`
      await run(
        options.ffmpegPath,
        ['-y', '-i', staged, '-af', masterTrimFilter(gainDb), '-ar', String(STITCH_RATE_HZ), '-c:a', 'libmp3lame', '-q:a', '2', options.output],
        Math.max(1, options.totalDurationSec + 5),
        'Narration mastering',
        options.signal
      )
    }
    await fs.rm(staged, { force: true }).catch(() => undefined)
    return { masterFilter }
  } finally {
    await fs.rm(listFile, { force: true }).catch(() => undefined)
  }
}

// --- final-audio measurements (logged in the QA report) ------------------------

export interface AudioMetrics {
  /** Integrated loudness (LUFS) — target −14 for TikTok. */
  integratedLufs: number | null
  /** Loudness range (LU) — narration target 5–7. */
  loudnessRangeLu: number | null
  /** Estimated noise floor: quietest non-digital-silence window (dBFS). */
  noiseFloorDbfs: number | null
}

function toNumberOrMinusInf(raw: string): number | null {
  if (raw === '-inf' || raw === '-120.0' || raw === '-120') return -120
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse ffmpeg's ebur128 + astats logs (pure — unit-tested). Per-frame lines
 * print `LRA: 0.0` early in the stream, so integrated/LRA must come from the
 * trailing `Summary:` block; the noise floor is the quietest non-silent astats
 * window (gaps are digital zero, gated out below −90 dBFS).
 */
export function parseAudioMetricsLogs(loudnessLog: string, statsLog: string): AudioMetrics {
  const measured: AudioMetrics = { integratedLufs: null, loudnessRangeLu: null, noiseFloorDbfs: null }
  const summary = loudnessLog.slice(loudnessLog.lastIndexOf('Summary:'))
  const integrated = /Integrated loudness:\s*\n\s*I:\s*(-?[0-9.]+|-inf) LUFS/.exec(summary)
  const lra = /LRA:\s*(-?[0-9.]+|-inf) LU\b/.exec(summary)
  if (integrated) measured.integratedLufs = toNumberOrMinusInf(integrated[1]!)
  if (lra) measured.loudnessRangeLu = toNumberOrMinusInf(lra[1]!)
  const rmsValues = [...statsLog.matchAll(/(?:RMS level dB: |lavfi\.astats\.Overall\.RMS_level=)(-?[0-9.]+|-inf)/g)]
    .map((m) => toNumberOrMinusInf(m[1]!))
    .filter((v): v is number => v !== null && v > -90)
  if (rmsValues.length > 0) measured.noiseFloorDbfs = Math.round(Math.min(...rmsValues) * 10) / 10
  return measured
}

/**
 * Measure the finished file: EBU R128 integrated loudness + LRA from one
 * ebur128 pass, and an estimated noise floor from the quietest non-silent
 * astats window (gaps are digital zero and excluded via the −90 dBFS gate).
 * Returns nulls (never throws) — a measurement failure must not fail a
 * generation that already produced audio.
 */
export async function measureAudioMetrics(
  ffmpegPath: string,
  file: string,
  signal?: AbortSignal
): Promise<AudioMetrics> {
  const empty: AudioMetrics = { integratedLufs: null, loudnessRangeLu: null, noiseFloorDbfs: null }
  try {
    signal?.throwIfAborted()
    const loudness = await runFfmpeg({
      ffmpegPath, args: ['-hide_banner', '-i', file, '-af', 'ebur128', '-f', 'null', '-'],
      durationSec: 1, signal, stderrTailLines: 100
    })
    if (loudness.cancelled || signal?.aborted) throw new Error('Narration cancelled')
    const metrics = loudness.code === 0 ? parseAudioMetricsLogs(loudness.stderrTail.join('\n'), '') : { ...empty }
    let quietest: number | null = null
    const stats = await runFfmpeg({
      ffmpegPath,
      args: ['-hide_banner', '-i', file, '-af', `aresample=${STITCH_RATE_HZ},asetnsamples=n=${STITCH_RATE_HZ * 4}:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level`, '-f', 'null', '-'],
      durationSec: 1, signal,
      onStderrLine: (line) => {
        const value = parseAudioMetricsLogs('', line).noiseFloorDbfs
        if (value !== null && (quietest === null || value < quietest)) quietest = value
      }
    })
    if (stats.cancelled || signal?.aborted) throw new Error('Narration cancelled')
    metrics.noiseFloorDbfs = stats.code === 0 ? quietest : null
    return metrics
  } catch {
    if (signal?.aborted) throw new Error('Narration cancelled')
    return empty
  }
}
