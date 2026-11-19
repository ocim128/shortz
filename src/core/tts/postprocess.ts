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
 *  - a fixed mastering chain (high-pass → tone EQ → compressor → loudnorm).
 */

/** Breath kept before the first and after the last syllable of a chunk. */
export const BREATH_MS = 25
/** Anti-click fades on every chunk edge. */
export const EDGE_FADE_SEC = 0.015
/** Uniform stitch format. */
export const STITCH_RATE_HZ = 48_000

/** The fixed broadcast chain (--master; TikTok-ready loudness at the end). */
export const MASTER_FILTER =
  'highpass=f=80,' +
  'equalizer=f=140:t=q:w=1.2:g=3,' +
  'equalizer=f=450:t=q:w=1.5:g=-2.5,' +
  'equalizer=f=3200:t=q:w=1.2:g=2,' +
  'acompressor=threshold=-18dB:ratio=3:attack=5:release=60,' +
  'loudnorm=I=-14:TP=-1.0:LRA=7'

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
 * an accepted-with-warnings/failed status in the report anyway).
 */
export function planTrim(words: AsrWord[], rawDurationSec: number, breathMs = BREATH_MS): TrimPlan {
  const breathSec = breathMs / 1000
  if (words.length === 0 || rawDurationSec <= 0) {
    return { startSec: 0, durationSec: rawDurationSec, speechStartSec: 0, speechEndSec: rawDurationSec }
  }
  const first = words[0]!
  const last = words[words.length - 1]!
  const startSec = Math.max(0, first.start - breathSec)
  const endSec = Math.min(rawDurationSec, last.end + breathSec)
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
  return Math.max(0, (timeSec - trim.startSec) / pacing)
}

/** argv: raw chunk WAV → trimmed, faded, paced, 48 kHz mono PCM WAV. */
export function chunkProcessArgs(input: {
  source: string
  output: string
  trim: TrimPlan
  pacing: number
}): string[] {
  const pacedDuration = input.trim.durationSec / input.pacing
  const fadeOutStart = Math.max(0, pacedDuration - EDGE_FADE_SEC)
  const filters = [
    `atempo=${input.pacing.toFixed(4)}`,
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
 *  - 500 ms before a [twist] reveal (the pre-reveal beat),
 *  - 280 ms at a numbered step or a [tactical] transition,
 *  - 140 ms at a plain sentence break.
 */
export function gapMsAfter(current: NarrationChunk, next: NarrationChunk): number {
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

/** argv: concat list → narration.mp3, optionally through the master chain. */
export function stitchArgs(input: { listFile: string; output: string; master: boolean }): string[] {
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', input.listFile]
  if (input.master) args.push('-af', MASTER_FILTER, '-ar', String(STITCH_RATE_HZ))
  args.push('-c:a', 'libmp3lame', '-q:a', '2', input.output)
  return args
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

export async function stitchNarration(options: {
  ffmpegPath: string
  files: string[]
  output: string
  master: boolean
  totalDurationSec: number
  signal?: AbortSignal
}): Promise<void> {
  const listFile = path.join(
    path.dirname(options.output),
    `.${path.basename(options.output)}.ffconcat.tmp`
  )
  await atomicWriteFile(listFile, buildConcatList(options.files))
  try {
    await run(
      options.ffmpegPath,
      stitchArgs({ listFile, output: options.output, master: options.master }),
      Math.max(1, options.totalDurationSec + 5),
      options.master ? 'Narration mastering' : 'Narration stitch',
      options.signal
    )
  } finally {
    await fs.rm(listFile, { force: true }).catch(() => undefined)
  }
}
