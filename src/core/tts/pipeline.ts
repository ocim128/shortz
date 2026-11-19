import { promises as fs } from 'node:fs'
import path from 'node:path'
import { synthesizeVoxChunk, voxReferencePath } from './voxcpm'
import { transcribeChunk, type AsrResult } from './asr'
import { splitIntoChunks, type NarrationChunk } from './chunks'
import {
  DEFAULT_DELIVERY,
  DELIVERY_TAGS,
  findVoicePreset
} from '../../shared/tts/voices'
import { checkAttempt, summarizeVerification, type ChunkVerification } from './verify'
import {
  gapMsAfter,
  MASTER_FILTER,
  processChunkWav,
  planTrim,
  renderGapSilence,
  stitchNarration,
  wordTimeInChunk,
  type TrimPlan
} from './postprocess'
import { atomicWriteFile } from '../store/fs-utils'

/**
 * The verified narration pipeline (CLI production mode): chunked synthesis →
 * per-chunk ASR verification with targeted retries → click-free stitching
 * with deliberate silence → broadcast mastering. Writes the MP3 plus the
 * timestamps and QA report artifacts Dimensi-Niskala consumes per episode.
 */

export interface NarrationPipelineInput {
  script: string
  voiceId: string
  /** Final mastered MP3 (e.g. narration.mp3). */
  outputMp3: string
  ffmpegPath: string
  voxWorkerPath: string
  asrWorkerPath: string
  pythonPath?: string
  asrPythonPath?: string
  referenceCacheDir?: string
  /** Run the broadcast mastering chain (default true). */
  master?: boolean
  signal?: AbortSignal
  onProgress?: (info: { phase: string; chunk?: number; totalChunks?: number }) => void
}

export interface NarrationTimestamps {
  version: 1
  voiceId: string
  /** Planned duration of the stitched narration (seconds). */
  durationSec: number
  master: boolean
  chunks: Array<{
    index: number
    tag: string | null
    text: string
    start: number
    end: number
    retries: number
    status: ChunkVerification['status']
  }>
  words: Array<{ word: string; start: number; end: number; chunk: number }>
}

export interface NarrationReport {
  version: 1
  voiceId: string
  voiceName: string
  master: boolean
  masterFilter: string | null
  generatedAt: string
  passed: boolean
  totalChunks: number
  verifiedChunks: number
  warningChunks: number
  failedChunks: number
  plannedDurationSec: number
  chunks: Array<{
    index: number
    tag: string | null
    text: string
    retries: number
    status: ChunkVerification['status']
    bestSimilarity: number
    attempts: Array<{
      seed: number
      similarity: number
      wpm: number
      expectedWpm: number
      passed: boolean
      reasons: string[]
    }>
  }>
}

export interface NarrationArtifacts {
  /** STAGED artifact paths (inside the pipeline's scratch dir) — the caller
   * publishes them (e.g. link into place) and must do so before the scratch
   * dir is needed again. The scratch dir is removed by stopNarrationPipeline. */
  mp3: string
  timestamps: string
  report: string
  passed: boolean
  durationSec: number
  /** Removes the scratch dir. Call after publishing (or on failure). */
  cleanup: () => Promise<void>
}

const RETRY_ATTEMPTS = 3
const SEED_STRIDE = 101 // matches the repair scripts' proven shift

function artifactPaths(outputMp3: string): { timestamps: string; report: string } {
  const ext = path.extname(outputMp3)
  const stem = outputMp3.slice(0, outputMp3.length - ext.length)
  return { timestamps: `${stem}-timestamps.json`, report: `${stem}-report.json` }
}

interface AcceptedChunk {
  chunk: NarrationChunk
  pacing: number
  verification: ChunkVerification
  winnerWav: string
  winnerAsr: AsrResult
  trim: TrimPlan
}

export async function runNarrationPipeline(input: NarrationPipelineInput): Promise<NarrationArtifacts> {
  const preset = findVoicePreset(input.voiceId)
  if (!preset) throw new Error(`Unknown voice: ${input.voiceId}`)
  const master = input.master !== false
  const chunks = splitIntoChunks(input.script)
  if (chunks.length === 0) throw new Error('The script contains no narration text')

  const workDir = await fs.mkdtemp(path.join(path.dirname(input.outputMp3), '.shortz-narration-'))
  const cleanup = async (): Promise<void> => {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
  // Everything is staged inside the scratch dir; the caller publishes, so a
  // cancelled or failed run never leaves a partial output behind.
  const stagedMp3 = path.join(workDir, path.basename(input.outputMp3))
  const python = input.pythonPath
  const asrPython = input.asrPythonPath
  try {
    // --- per-chunk synthesis + ASR verification + targeted retry -------------
    const accepted: AcceptedChunk[] = []
    for (const [i, chunk] of chunks.entries()) {
      input.onProgress?.({ phase: 'synthesizing', chunk: i + 1, totalChunks: chunks.length })
      const delivery = chunk.tag ? DELIVERY_TAGS[chunk.tag] : DEFAULT_DELIVERY
      const prompt = delivery.energyPrompt ? `${preset.prompt} ${delivery.energyPrompt}` : preset.prompt
      const reference = voxReferencePath(prompt, preset.seed, input.referenceCacheDir)

      const attempts: ReturnType<typeof checkAttempt>[] = []
      const attemptData: Array<{ wav: string; asr: AsrResult }> = []
      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
        input.signal?.throwIfAborted()
        const seed = preset.seed + attempt * SEED_STRIDE
        const wav = path.join(workDir, `c${i}-a${attempt}.wav`)
        await synthesizeVoxChunk(
          { text: chunk.text, prompt, seed, output: wav, reference },
          { pythonPath: python, workerPath: input.voxWorkerPath, signal: input.signal }
        )
        const asr = await transcribeChunk(wav, {
          pythonPath: asrPython,
          workerPath: input.asrWorkerPath,
          signal: input.signal
        })
        attempts.push(checkAttempt({ expected: chunk.text, seed, asr }))
        attemptData.push({ wav, asr })
        if (attempts[attempts.length - 1]!.passed) break
      }
      if (attemptData.length === 0) throw new Error(`Chunk ${i + 1} produced no synthesis attempts`)
      const verification = summarizeVerification(attempts)
      // The take actually used is summarize()'s choice: the best similarity,
      // forced to a fully passing take when one exists.
      const used = attemptData[verification.accepted]!
      accepted.push({
        chunk,
        pacing: delivery.pacing,
        verification,
        winnerWav: used.wav,
        winnerAsr: used.asr,
        trim: planTrim(used.asr.words, used.asr.durationSec)
      })
    }

    // --- condition chunks (trim + fades + pacing) ----------------------------
    const conditionedFiles: string[] = []
    const chunkDurations: number[] = []
    for (const [i, a] of accepted.entries()) {
      input.signal?.throwIfAborted()
      const out = path.join(workDir, `p${i}.wav`)
      await processChunkWav({
        ffmpegPath: input.ffmpegPath,
        source: a.winnerWav,
        output: out,
        trim: a.trim,
        pacing: a.pacing,
        signal: input.signal
      })
      conditionedFiles.push(out)
      chunkDurations.push(a.trim.durationSec / a.pacing)
    }

    // --- deliberate silence gaps ---------------------------------------------
    const gapFiles = new Map<number, string>()
    const stitchFiles: string[] = []
    const chunkStarts: number[] = []
    let timeline = 0
    for (let i = 0; i < accepted.length; i += 1) {
      input.signal?.throwIfAborted()
      chunkStarts.push(timeline)
      stitchFiles.push(conditionedFiles[i]!)
      timeline += chunkDurations[i]!
      if (i < accepted.length - 1) {
        const gapMs = gapMsAfter(accepted[i]!.chunk, accepted[i + 1]!.chunk)
        let gapFile = gapFiles.get(gapMs)
        if (!gapFile) {
          gapFile = path.join(workDir, `gap-${gapMs}.wav`)
          await renderGapSilence({
            ffmpegPath: input.ffmpegPath,
            file: gapFile,
            seconds: gapMs / 1000,
            signal: input.signal
          })
          gapFiles.set(gapMs, gapFile)
        }
        stitchFiles.push(gapFile)
        timeline += gapMs / 1000
      }
    }

    // --- stitch (+ master) and write the artifacts ----------------------------
    input.onProgress?.({ phase: 'mastering', totalChunks: accepted.length })
    await stitchNarration({
      ffmpegPath: input.ffmpegPath,
      files: stitchFiles,
      output: stagedMp3,
      master,
      totalDurationSec: timeline,
      signal: input.signal
    })

    const timestamps = buildTimestamps(input.voiceId, master, accepted, chunkStarts, chunkDurations, timeline)
    const report = buildReport(preset.id, preset.name, master, accepted, timeline)

    const paths = artifactPaths(stagedMp3)
    await atomicWriteFile(paths.timestamps, `${JSON.stringify(timestamps, null, 2)}\n`)
    await atomicWriteFile(paths.report, `${JSON.stringify(report, null, 2)}\n`)
    return {
      mp3: stagedMp3,
      timestamps: paths.timestamps,
      report: paths.report,
      passed: report.passed,
      durationSec: timeline,
      cleanup
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

function buildTimestamps(
  voiceId: string,
  master: boolean,
  accepted: AcceptedChunk[],
  chunkStarts: number[],
  chunkDurations: number[],
  timeline: number
): NarrationTimestamps {
  const words: NarrationTimestamps['words'] = []
  const chunkEntries: NarrationTimestamps['chunks'] = []
  accepted.forEach((a, i) => {
    const start = chunkStarts[i]!
    const end = start + chunkDurations[i]!
    chunkEntries.push({
      index: a.chunk.index,
      tag: a.chunk.tag,
      text: a.chunk.text,
      start: round3(start),
      end: round3(end),
      retries: a.verification.retries,
      status: a.verification.status
    })
    for (const w of a.winnerAsr.words) {
      words.push({
        word: w.word,
        start: round3(start + wordTimeInChunk(w.start, a.trim, a.pacing)),
        end: round3(start + wordTimeInChunk(w.end, a.trim, a.pacing)),
        chunk: a.chunk.index
      })
    }
  })
  return { version: 1, voiceId, durationSec: round3(timeline), master, chunks: chunkEntries, words }
}

function buildReport(
  voiceId: string,
  voiceName: string,
  master: boolean,
  accepted: AcceptedChunk[],
  timeline: number
): NarrationReport {
  const chunkEntries = accepted.map((a) => ({
    index: a.chunk.index,
    tag: a.chunk.tag,
    text: a.chunk.text,
    retries: a.verification.retries,
    status: a.verification.status,
    bestSimilarity: a.verification.attempts[a.verification.accepted]!.similarity,
    bestWordRatio: a.verification.attempts[a.verification.accepted]!.wordRatio,
    attempts: a.verification.attempts.map((att) => ({
      seed: att.seed,
      wordRatio: att.wordRatio,
      similarity: att.similarity,
      wpm: att.wpm,
      expectedWpm: att.expectedWpm,
      passed: att.passed,
      reasons: att.reasons,
      warnings: att.warnings
    }))
  }))
  const verified = chunkEntries.filter((c) => c.status === 'verified').length
  const warnings = chunkEntries.filter((c) => c.status === 'accepted-with-warnings').length
  const failed = chunkEntries.filter((c) => c.status === 'failed').length
  return {
    version: 1,
    voiceId,
    voiceName,
    master,
    masterFilter: master ? MASTER_FILTER : null,
    generatedAt: new Date().toISOString(),
    passed: failed === 0,
    totalChunks: chunkEntries.length,
    verifiedChunks: verified,
    warningChunks: warnings,
    failedChunks: failed,
    plannedDurationSec: round3(timeline),
    chunks: chunkEntries
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
