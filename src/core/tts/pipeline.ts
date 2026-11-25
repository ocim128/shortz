import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { transcribeChunk, type AsrResult } from './asr'
import { parseNarrationScript, type NarrationChunk } from './chunks'
import { DEFAULT_DELIVERY, DELIVERY_TAGS, findVoicePreset, type DeliveryTag } from '../../shared/tts/voices'
import { findVoicePreset as findEdgeVoicePreset } from '../../shared/tts/legacy-edge-voices'
import { checkAttempt, summarizeVerification, wordMismatches, type ChunkVerification } from './verify'
import {
  gapMsAfter,
  measureAudioMetrics,
  processChunkWav,
  conditionedWavDuration,
  planTrim,
  renderGapSilence,
  stitchNarration,
  type AudioMetrics,
} from './postprocess'
import { atomicWriteFile } from '../store/fs-utils'
import { createVoxProvider, type TtsProvider } from './provider'

/**
 * The verified narration pipeline (provider-agnostic): chunked synthesis →
 * per-chunk ASR verification with targeted retries → click-free stitching
 * with deliberate silence → broadcast mastering. Writes the MP3 plus the
 * timestamps and QA report artifacts Dimensi-Niskala consumes per episode.
 *
 * All synthesis goes through the TtsProvider seam (src/core/tts/provider.ts):
 * every chunk of an episode conditions on the provider's ONE voice identity,
 * and delivery energies are applied purely in post (level/pacing/gaps).
 */

export interface NarrationPipelineInput {
  script: string
  voiceId: string
  /** Final mastered MP3 (e.g. narration.mp3). */
  outputMp3: string
  ffmpegPath: string
  /** Synthesis provider (default: local VoxCPM). */
  provider?: TtsProvider
  /** Verifier worker + runtime. */
  asrWorkerPath: string
  asrPythonPath?: string
  /** Whisper model size (default "small" in the verifier). */
  asrModel?: string
  referenceCacheDir?: string
  pythonPath?: string
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
  sfx: Array<{ name: string; time: number }>
}

export interface NarrationReport {
  version: 1
  voiceId: string
  voiceName: string
  provider: string
  model: string
  master: boolean
  masterFilter: string | null
  asrModel: string
  generatedAt: string
  passed: boolean
  totalChunks: number
  verifiedChunks: number
  warningChunks: number
  failedChunks: number
  plannedDurationSec: number
  finalAlignment?: {
    transcript: string
    mismatches: Array<{ expected: string | null; heard: string | null }>
    passed: boolean
  }
  audioQuality: AudioMetrics & {
    targets: { integratedLufs: number; loudnessRangeLu: [number, number] }
  }
  chunks: Array<{
    index: number
    tag: string | null
    text: string
    retries: number
    status: ChunkVerification['status']
    bestSimilarity: number
    bestWordRatio: number
    acceptedAttempt: number
    attempts: Array<{
      seed: number
      wordRatio: number
      similarity: number
      wpm: number
      expectedWpm: number
      passed: boolean
      reasons: string[]
      warnings: string[]
      transcript: string
      mismatches: Array<{ expected: string | null; heard: string | null }>
      endTruncated: boolean
      rawTranscript?: string
      rawMismatches?: Array<{ expected: string | null; heard: string | null }>
      rawEndTruncated?: boolean
      rawReasons?: string[]
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
  audioQuality: AudioMetrics
  /** Removes scratch files and, unless preserved, the per-output resume cache. */
  cleanup: (options?: { preserveCache?: boolean }) => Promise<void>
}

const RETRY_ATTEMPTS = 3

function artifactPaths(outputMp3: string): { timestamps: string; report: string } {
  const ext = path.extname(outputMp3)
  const stem = outputMp3.slice(0, outputMp3.length - ext.length)
  return { timestamps: `${stem}-timestamps.json`, report: `${stem}-report.json` }
}

interface AcceptedChunk {
  chunk: NarrationChunk
  delivery: DeliveryTag
  verification: ChunkVerification
  conditionedWav: string
  winnerAsr: AsrResult
}

export async function runNarrationPipeline(input: NarrationPipelineInput): Promise<NarrationArtifacts> {
  const provider = input.provider ?? createVoxProvider({ workerPath: path.join(path.dirname(input.asrWorkerPath), 'voxcpm_worker.py') })
  if (provider.id === 'voxcpm' && !findVoicePreset(input.voiceId)) throw new Error(`Unknown voice: ${input.voiceId}`)
  if (provider.id === 'edge' && !findEdgeVoicePreset(input.voiceId)) throw new Error(`Unknown Edge voice: ${input.voiceId}`)
  const master = input.master !== false
  const { chunks, sfx } = parseNarrationScript(input.script)
  if (chunks.length === 0) throw new Error('The script contains no narration text')

  const workDir = await fs.mkdtemp(path.join(path.dirname(input.outputMp3), '.shortz-narration-'))
  const isGemini = provider.id === 'gemini-tts' || provider.id === 'gemini-cloud'
  const geminiCacheDir = isGemini
    ? path.join(path.dirname(input.outputMp3), '.shortz-tts-cache', createHash('sha256').update(path.resolve(input.outputMp3)).digest('hex'))
    : undefined
  const cleanup = async (options?: { preserveCache?: boolean }): Promise<void> => {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    if (geminiCacheDir && !options?.preserveCache) {
      await fs.rm(geminiCacheDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  // Everything is staged inside the scratch dir; the caller publishes, so a
  // cancelled or failed run never leaves a partial output behind.
  const stagedMp3 = path.join(workDir, path.basename(input.outputMp3))
  try {
    // --- per-chunk synthesis + ASR verification + targeted retry -------------
    const accepted: AcceptedChunk[] = []
    for (const [i, chunk] of chunks.entries()) {
      input.onProgress?.({ phase: 'synthesizing', chunk: i + 1, totalChunks: chunks.length })
      const delivery = chunk.tag ? DELIVERY_TAGS[chunk.tag] : DEFAULT_DELIVERY

      const attempts: ReturnType<typeof checkAttempt>[] = []
      const attemptData: Array<{ wav: string; asr: AsrResult }> = []
      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
        input.signal?.throwIfAborted()
        const wav = path.join(workDir, `c${i}-a${attempt}.wav`)
        await provider.synthesizeChunk(
          { text: chunk.text, tag: chunk.tag, chunkIndex: i, attempt, outputWav: wav },
          {
            voiceId: input.voiceId,
            ffmpegPath: input.ffmpegPath,
            ...(input.referenceCacheDir ? { referenceCacheDir: input.referenceCacheDir } : {}),
            ...(input.pythonPath ? { pythonPath: input.pythonPath } : {}),
            ...(geminiCacheDir ? { geminiCacheDir, onGeminiCacheHit: () => input.onProgress?.({ phase: 'resuming', chunk: i + 1, totalChunks: chunks.length }) } : {}),
            signal: input.signal
          }
        )
        const asr = await transcribeChunk(wav, {
          workerPath: input.asrWorkerPath,
          ...(input.asrPythonPath ? { pythonPath: input.asrPythonPath } : {}),
          ...(input.asrModel ? { model: input.asrModel } : {}),
          signal: input.signal
        })
        const out = path.join(workDir, `p${i}-a${attempt}.wav`)
        const trim = planTrim(asr.words, asr.durationSec, undefined, attempt * 40)
        await processChunkWav({ ffmpegPath: input.ffmpegPath, source: wav, output: out, trim,
          pacing: delivery.pacing, levelDb: delivery.levelDb, signal: input.signal,
          ...(provider.id === 'gemini-cloud' ? { profile: 'gemini-cloud' as const }
            : isGemini ? { profile: 'gemini-tts' as const } : {}) })
        const finalAsr = await transcribeChunk(out, {
          workerPath: input.asrWorkerPath,
          ...(input.asrPythonPath ? { pythonPath: input.asrPythonPath } : {}),
          ...(input.asrModel ? { model: input.asrModel } : {}), signal: input.signal
        })
        const rawCheck = checkAttempt({ expected: chunk.text, seed: attempt, asr })
        const finalCheck = checkAttempt({ expected: chunk.text, seed: attempt, asr: finalAsr })
        finalCheck.rawTranscript = rawCheck.transcript
        finalCheck.rawMismatches = rawCheck.mismatches
        finalCheck.rawEndTruncated = rawCheck.endTruncated
        finalCheck.rawReasons = rawCheck.reasons
        if (!rawCheck.passed) {
          finalCheck.passed = false
          finalCheck.reasons.unshift(...rawCheck.reasons.map((reason) => `raw: ${reason}`))
        }
        attempts.push(finalCheck)
        attemptData.push({ wav: out, asr: finalAsr })
        if (attempts[attempts.length - 1]!.passed) break
      }
      if (attemptData.length === 0) throw new Error(`Chunk ${i + 1} produced no synthesis attempts`)
      const verification = summarizeVerification(attempts)
      // Retain the best take for review when none passes.
      const used = attemptData[verification.accepted]!
      accepted.push({
        chunk,
        delivery,
        verification,
        conditionedWav: used.wav,
        winnerAsr: used.asr
      })
    }
    provider.stop()

    // --- condition chunks (trim + denoise + level + fades) -------------------
    const conditionedFiles: string[] = []
    const chunkDurations: number[] = []
    for (const a of accepted) {
      input.signal?.throwIfAborted()
      conditionedFiles.push(a.conditionedWav)
      chunkDurations.push(await conditionedWavDuration(a.conditionedWav))
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

    // --- stitch (+ master), measure, and write the artifacts ------------------
    input.onProgress?.({ phase: 'mastering', totalChunks: accepted.length })
    const { masterFilter } = await stitchNarration({
      ffmpegPath: input.ffmpegPath,
      files: stitchFiles,
      output: stagedMp3,
      master,
      totalDurationSec: timeline,
      ...(isGemini ? { profile: 'gemini-tts' as const } : {}),
      signal: input.signal
    })
    const audioQuality = await measureAudioMetrics(input.ffmpegPath, stagedMp3, input.signal)

    // Re-align the completed Gemini MP3 so timestamps describe the final encode.
    const finalAsr = isGemini ? await transcribeChunk(stagedMp3, {
      workerPath: input.asrWorkerPath,
      ...(input.asrPythonPath ? { pythonPath: input.asrPythonPath } : {}),
      ...(input.asrModel ? { model: input.asrModel } : {}), signal: input.signal
    }) : undefined
    const mismatches = finalAsr ? wordMismatches(chunks.map((chunk) => chunk.text).join(' '), finalAsr.transcript) : undefined
    const finalAlignment = finalAsr && mismatches ? {
      transcript: finalAsr.transcript, mismatches, passed: mismatches.length === 0 && finalAsr.words.length > 0
    } : undefined
    const timestamps = buildTimestamps(input.voiceId, master, accepted, chunkStarts, chunkDurations, timeline, sfx, finalAsr)
    const report = buildReport(input, provider, masterFilter, accepted, timeline, audioQuality, finalAlignment)

    const paths = artifactPaths(stagedMp3)
    await atomicWriteFile(paths.timestamps, `${JSON.stringify(timestamps, null, 2)}\n`)
    await atomicWriteFile(paths.report, `${JSON.stringify(report, null, 2)}\n`)
    return {
      mp3: stagedMp3,
      timestamps: paths.timestamps,
      report: paths.report,
      passed: report.passed,
      durationSec: timeline,
      audioQuality,
      cleanup
    }
  } catch (error) {
    provider.stop()
    await cleanup({ preserveCache: true })
    throw error
  }
}

function buildTimestamps(
  voiceId: string,
  master: boolean,
  accepted: AcceptedChunk[],
  chunkStarts: number[],
  chunkDurations: number[],
  timeline: number,
  sfx: Array<{ name: string; beforeChunk: number }>,
  finalAsr?: AsrResult
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
    for (const w of finalAsr ? [] : a.winnerAsr.words) {
      words.push({
        word: w.word,
        start: round3(start + Math.min(chunkDurations[i]!, Math.max(0, w.start))),
        end: round3(start + Math.min(chunkDurations[i]!, Math.max(0, w.end))),
        chunk: a.chunk.index
      })
    }
  })
  if (finalAsr) {
    for (const w of finalAsr.words) {
      const midpoint = (w.start + w.end) / 2
      let nearest = 0
      let minDistance = Infinity
      for (let i = 0; i < accepted.length; i++) {
        const start = chunkStarts[i]!
        const end = start + chunkDurations[i]!
        const distance = midpoint < start ? start - midpoint : midpoint > end ? midpoint - end : 0
        if (distance < minDistance) { nearest = i; minDistance = distance }
      }
      words.push({ word: w.word, start: round3(w.start), end: round3(w.end), chunk: accepted[nearest]!.chunk.index })
    }
  }
  return { version: 1, voiceId, durationSec: round3(timeline), master, chunks: chunkEntries, words,
    sfx: sfx.map((marker) => ({ name: marker.name, time: round3(chunkStarts[marker.beforeChunk] ?? timeline) })) }
}

function buildReport(
  input: NarrationPipelineInput,
  provider: TtsProvider,
  masterFilter: string | null,
  accepted: AcceptedChunk[],
  timeline: number,
  audioQuality: AudioMetrics,
  finalAlignment?: NarrationReport['finalAlignment']
): NarrationReport {
  const chunkEntries = accepted.map((a) => ({
    index: a.chunk.index,
    tag: a.chunk.tag,
    text: a.chunk.text,
    retries: a.verification.retries,
    status: a.verification.status,
    bestSimilarity: a.verification.attempts[a.verification.accepted]!.similarity,
    bestWordRatio: a.verification.attempts[a.verification.accepted]!.wordRatio,
    acceptedAttempt: a.verification.accepted,
    attempts: a.verification.attempts.map((att) => ({
      seed: att.seed,
      wordRatio: att.wordRatio,
      similarity: att.similarity,
      wpm: att.wpm,
      expectedWpm: att.expectedWpm,
      passed: att.passed,
      reasons: att.reasons,
      warnings: att.warnings,
      transcript: att.transcript,
      mismatches: att.mismatches,
      endTruncated: att.endTruncated,
      rawTranscript: att.rawTranscript,
      rawMismatches: att.rawMismatches,
      rawEndTruncated: att.rawEndTruncated,
      rawReasons: att.rawReasons
    }))
  }))
  const verified = chunkEntries.filter((c) => c.status === 'verified').length
  const warnings = 0 // Kept for report compatibility; strict mode never accepts a failed take.
  const failed = chunkEntries.filter((c) => c.status === 'failed').length
  return {
    version: 1,
    voiceId: input.voiceId,
    voiceName: provider.id === 'voxcpm' ? 'Configured reference voice' : (provider.id === 'edge' ? findEdgeVoicePreset(input.voiceId) : findVoicePreset(input.voiceId))?.name ?? input.voiceId,
    provider: provider.id,
    model: provider.model ?? provider.id,
    master: masterFilter !== null,
    masterFilter,
    asrModel: input.asrModel ?? 'small',
    generatedAt: new Date().toISOString(),
    passed: failed === 0 && (finalAlignment?.passed ?? true),
    totalChunks: chunkEntries.length,
    verifiedChunks: verified,
    warningChunks: warnings,
    failedChunks: failed,
    plannedDurationSec: round3(timeline),
    ...(finalAlignment ? { finalAlignment } : {}),
    audioQuality: {
      ...audioQuality,
      targets: { integratedLufs: -14, loudnessRangeLu: [5, 7] }
    },
    chunks: chunkEntries
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
