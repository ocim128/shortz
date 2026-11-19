import { promises as fs } from 'node:fs'
import { buildSsml } from './ssml'
import { synthesizeEdgeTts } from './net/edge-tts-client'
import { synthesizeVoxChunk, voxReferencePath, stopVoxWorker } from './voxcpm'
import { runFfmpeg } from '../ffmpeg/runner'
import { findVoicePreset } from '../../shared/tts/voices'
import { findVoicePreset as findLegacyVoicePreset } from '../../shared/tts/legacy-edge-voices'
import { createGeminiTtsProvider } from './gemini-tts'
import { createGeminiCloudProvider } from './gemini-cloud'
import type { DeliveryTagId } from '../../shared/tts/voices'

/**
 * The synthesis seam of the narration pipeline (chunking, ASR verification,
 * stitching, denoising, mastering, and the timestamps/report artifacts are
 * provider-agnostic). A provider just fills scratch files with chunk audio;
 * swapping VoxCPM for a native Indonesian cloud TTS later is a new factory
 * here plus a `--provider` value — no pipeline changes.
 */

export interface TtsProviderChunkRequest {
  /** Clean chunk text — delivery tags already stripped. */
  text: string
  /** Delivery section active for this chunk. */
  tag?: DeliveryTagId | null
  chunkIndex: number
  /** 0-based retry index; providers may shift their seed on retries. */
  attempt: number
  /** Absolute path the provider must write the chunk audio to. */
  outputWav: string
}

export interface TtsProviderContext {
  voiceId: string
  ffmpegPath: string
  referenceCacheDir?: string
  /** Optional per-output resume cache for Gemini synthesis. */
  geminiCacheDir?: string
  onGeminiCacheHit?: () => void
  pythonPath?: string
  signal?: AbortSignal
}

export interface TtsProvider {
  /** Stable id — the CLI `--provider` value. */
  readonly id: string
  readonly model?: string
  /** Synthesize one chunk into request.outputWav. */
  synthesizeChunk(request: TtsProviderChunkRequest, context: TtsProviderContext): Promise<void>
  /** Release workers/connections after an episode. */
  stop(): void
}

// --- VoxCPM (local, default) ----------------------------------------------------

/**
 * The single-reference rule: every chunk of an episode conditions on the SAME
 * reference clip + the SAME prompt, so speaker identity and Indonesian accent
 * cannot drift between chunks (the per-tag reference experiment caused exactly
 * that drift). Delivery energies are post-processing only.
 */
export function createVoxProvider(options?: { workerPath?: string }): TtsProvider {
  const workerPath = options?.workerPath ?? ''
  return {
    id: 'voxcpm',
    model: 'openbmb/VoxCPM2',
    async synthesizeChunk(request, context) {
      const preset = findVoicePresetOrThrow(context.voiceId)
      await synthesizeVoxChunk(
        {
          text: request.text,
          prompt: preset.prompt,
          // Fixed per voice; retries shift it subtly (worker regenerates the
          // seed-dependent noise, never the cached reference).
          seed: preset.seed + request.attempt * 101,
          output: request.outputWav,
          reference: voxReferencePath(preset.prompt, preset.seed, context.referenceCacheDir),
          ffmpeg_path: context.ffmpegPath
        },
        {
          ...(context.pythonPath ? { pythonPath: context.pythonPath } : {}),
          workerPath,
          signal: context.signal
        }
      )
    },
    stop() {
      stopVoxWorker()
    }
  }
}

// --- Edge TTS (legacy cloud path, no key) ----------------------------------------

export function createEdgeProvider(): TtsProvider {
  return {
    id: 'edge',
    async synthesizeChunk(request, context) {
      const legacy = findLegacyVoicePreset(context.voiceId)
      if (!legacy) throw new Error(`Unknown Edge voice: ${context.voiceId}`)
      const { audio } = await synthesizeEdgeTts({
        ssml: buildSsml(request.text, legacy),
        signal: context.signal
      })
      const rawMp3 = `${request.outputWav}.edge.mp3`
      await fs.writeFile(rawMp3, audio)
      try {
        const result = await runFfmpeg({
          ffmpegPath: context.ffmpegPath,
          args: ['-y', '-i', rawMp3, '-ac', '1', '-c:a', 'pcm_s16le', request.outputWav],
          durationSec: Math.max(1, request.text.length / 14),
          signal: context.signal
        })
        if (result.cancelled || context.signal?.aborted) throw new Error('Narration cancelled')
        if (result.code !== 0)
          throw new Error(`Edge chunk conversion failed: ${result.stderrTail.slice(-3).join(' ')}`)
      } finally {
        await fs.rm(rawMp3, { force: true }).catch(() => undefined)
      }
    },
    stop() {
      /* stateless HTTPS client — nothing to release */
    }
  }
}

/** ElevenLabs' multilingual TTS endpoint; credentials and the voice are configured externally. */
export function createCloudProvider(options?: { fetchImpl?: typeof fetch }): TtsProvider {
  const model = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2'
  return {
    id: 'cloud', model,
    async synthesizeChunk(request, context) {
      const key = process.env.ELEVENLABS_API_KEY
      const voice = context.voiceId || process.env.ELEVENLABS_VOICE_ID
      if (!key || !voice) throw new Error('Cloud TTS requires ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID')
      const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
      const response = await (options?.fetchImpl ?? fetch)(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
        { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ text: request.text, model_id: model }), signal }
      )
      if (!response.ok) throw new Error(`Cloud TTS failed (HTTP ${response.status})`)
      const rawMp3 = `${request.outputWav}.cloud.mp3`
      const audio = Buffer.from(await response.arrayBuffer())
      if (!audio.length) throw new Error('Cloud TTS returned empty audio')
      try {
        await fs.writeFile(rawMp3, audio)
        const result = await runFfmpeg({ ffmpegPath: context.ffmpegPath,
          args: ['-y', '-i', rawMp3, '-ac', '1', '-c:a', 'pcm_s16le', request.outputWav],
          durationSec: Math.max(1, request.text.length / 14), signal: context.signal })
        if (result.cancelled || context.signal?.aborted) throw new Error('Narration cancelled')
        if (result.stalled || result.code !== 0) throw new Error('Cloud TTS audio conversion failed')
      } finally {
        await fs.rm(rawMp3, { force: true }).catch(() => undefined)
      }
    },
    stop() { /* no persistent connection */ }
  }
}

export const PROVIDER_IDS = ['voxcpm', 'edge', 'cloud', 'gemini-tts', 'gemini-cloud'] as const
export type TtsProviderId = (typeof PROVIDER_IDS)[number]

/** Resolve a `--provider` value; `workerPath` applies to voxcpm only. */
export function createProvider(
  id: string,
  options?: { voxWorkerPath?: string; model?: string; geminiApiKeys?: string[]; googleCloudProject?: string }
): TtsProvider {
  switch (id) {
    case 'voxcpm':
      return createVoxProvider({ ...(options?.voxWorkerPath ? { workerPath: options.voxWorkerPath } : {}) })
    case 'edge':
      return createEdgeProvider()
    case 'cloud':
      return createCloudProvider()
    case 'gemini-tts':
      return createGeminiTtsProvider({ model: options?.model, apiKeys: options?.geminiApiKeys })
    case 'gemini-cloud':
      return createGeminiCloudProvider({ model: options?.model, project: options?.googleCloudProject })
    default:
      throw new Error(`Unknown speech provider: ${id}. Known: ${PROVIDER_IDS.join(', ')}`)
  }
}

function findVoicePresetOrThrow(voiceId: string) {
  const preset = findVoicePreset(voiceId)
  if (!preset) throw new Error(`Unknown voice: ${voiceId}`)
  return preset
}
