import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { synthesizeEdgeTts, TtsCancelledError, type SocketFactory } from './net/edge-tts-client'
import { buildSsml, splitSentences } from './ssml'
import { findVoicePreset, TTS_MAX_TEXT_LENGTH } from '../../shared/tts/voices'
import { atomicWriteFile } from '../store/fs-utils'
import { runFfmpeg } from '../ffmpeg/runner'

/**
 * TTS orchestration: validate → resolve preset → one Edge request per sentence
 * (the endpoint rejects `<break>` with a hard 1007, so dramatic pauses are
 * ffmpeg silence between sentence MP3s) → single re-encode to the output path.
 *
 * Single-sentence input skips ffmpeg entirely — the one buffer IS the output.
 */

export interface TtsSynthesisInput {
  text: string
  voiceId: string
  /** Absolute destination (.mp3). */
  outputPath: string
  /** Required for the multi-sentence stitch; unused for single sentences. */
  ffmpegPath: string
  signal?: AbortSignal
  /** Test seam — hermetic integration tests inject a fake socket. */
  socketFactory?: SocketFactory
}

export interface TtsSynthesisResult {
  path: string
  bytes: number
}

function validate(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('Enter some text to convert to speech')
  if (trimmed.length > TTS_MAX_TEXT_LENGTH)
    throw new Error(`Text is too long (${trimmed.length} chars; max ${TTS_MAX_TEXT_LENGTH})`)
  return trimmed
}

/** ffconcat `file` entry — single-quoted, `'` escaped the ffconcat way. */
function concatEntry(file: string): string {
  return `file '${file.replace(/'/g, "'\\''")}'`
}

/** Rough duration for the runner's progress/stall math only (≈14 chars/s). */
function estimateDurationSec(sentences: string[], pauseMs: number): number {
  const chars = sentences.reduce((n, s) => n + s.length, 0)
  return Math.max(1, chars / 14 + (sentences.length * pauseMs) / 1000)
}

/**
 * Silence gap as an MP3 matching the service's stream (24 kHz mono 48 kbps),
 * so the concat sees one homogeneous timeline.
 */
async function renderSilence(
  ffmpegPath: string,
  file: string,
  seconds: number,
  signal?: AbortSignal
): Promise<void> {
  const result = await runFfmpeg({
    ffmpegPath,
    args: ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(seconds), '-c:a', 'libmp3lame', '-b:a', '48k', file],
    durationSec: seconds,
    signal
  })
  if (result.cancelled || signal?.aborted) throw new TtsCancelledError()
  if (result.code !== 0)
    throw new Error(`Silence render failed: ${result.stderrTail.slice(-3).join(' ')}`)
}

export async function synthesizeSpeech(input: TtsSynthesisInput): Promise<TtsSynthesisResult> {
  const text = validate(input.text)
  const preset = findVoicePreset(input.voiceId)
  if (!preset) throw new Error(`Unknown voice: ${input.voiceId}`)

  const sentences = splitSentences(text)
  if (sentences.length === 0) throw new Error('Enter some text to convert to speech')

  const synthesizeOne = async (sentence: string): Promise<Buffer> => {
    const { audio } = await synthesizeEdgeTts({
      ssml: buildSsml(sentence, preset),
      signal: input.signal,
      ...(input.socketFactory ? { socketFactory: input.socketFactory } : {})
    })
    if (input.signal?.aborted) throw new TtsCancelledError()
    return audio
  }

  // Fast path: one sentence = the buffer is the deliverable.
  if (sentences.length === 1) {
    const audio = await synthesizeOne(sentences[0]!)
    await atomicWriteFile(input.outputPath, audio)
    return { path: input.outputPath, bytes: audio.length }
  }

  // Multi-sentence: per-sentence MP3s in a scratch dir + one silence gap,
  // concatenated with the gap BEFORE every sentence except the first — the
  // same rhythm as a dramatic pause after each sentence.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shortz-tts-'))
  try {
    const sentenceFiles: string[] = []
    for (const [i, sentence] of sentences.entries()) {
      const audio = await synthesizeOne(sentence)
      const file = path.join(dir, `s${i}.mp3`)
      await fs.writeFile(file, audio)
      sentenceFiles.push(file)
    }
    const pause = path.join(dir, 'pause.mp3')
    await renderSilence(input.ffmpegPath, pause, preset.sentenceBreakMs / 1000, input.signal)

    const listFile = `${input.outputPath}.ffconcat.tmp`
    const lines = ['ffconcat version 1.0']
    sentenceFiles.forEach((file, i) => {
      if (i > 0) lines.push(concatEntry(pause))
      lines.push(concatEntry(file))
    })
    await atomicWriteFile(listFile, `${lines.join('\n')}\n`)
    try {
      const result = await runFfmpeg({
        ffmpegPath: input.ffmpegPath,
        args: ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '4', input.outputPath],
        durationSec: estimateDurationSec(sentences, preset.sentenceBreakMs),
        signal: input.signal
      })
      if (result.cancelled || input.signal?.aborted) throw new TtsCancelledError()
      if (result.stalled) throw new Error('Speech stitch stalled')
      if (result.code !== 0)
        throw new Error(`Speech stitch failed: ${result.stderrTail.slice(-4).join(' ')}`)
    } finally {
      await fs.rm(listFile, { force: true }).catch(() => undefined)
    }
    const bytes = (await fs.stat(input.outputPath)).size
    return { path: input.outputPath, bytes }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
