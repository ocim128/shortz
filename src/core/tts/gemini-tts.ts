import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { DeliveryTagId } from '../../shared/tts/voices'
import { DEFAULT_GEMINI_TTS_VOICE, GEMINI_TTS_VOICES } from '../../shared/tts/gemini'
import type { TtsProvider } from './provider'
import { GEMINI_API_KEY_NAMES } from './environment'

export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts'
export { DEFAULT_GEMINI_TTS_VOICE, GEMINI_TTS_VOICES } from '../../shared/tts/gemini'

/** Designed voice IDs belong to the Google project that created them. */
export function isGeminiCustomVoice(voice: string): boolean {
  return /^voice_[A-Za-z0-9_-]+$/.test(voice)
}

export const GEMINI_DELIVERY_STYLES: Record<DeliveryTagId, string> = {
  hook: 'Calm, firm, urgent Indonesian survival-thriller narrator, slightly brisk pace',
  tactical: 'Clear, authoritative, controlled Indonesian documentary thriller narrator',
  twist: 'Slow, quiet, tense hushed delivery with eerie suspense'
}

/** Google may supply retry advice in a header or google.rpc.RetryInfo. */
async function retryDelayMs(response: Response, attempt: number): Promise<number> {
  const header = response.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  }
  try {
    const body = await response.json() as { error?: { details?: Array<{ retryDelay?: string }> } }
    const value = body.error?.details?.find((detail) => typeof detail.retryDelay === 'string')?.retryDelay
    const match = value?.match(/^(\d+(?:\.\d+)?)s$/)
    if (match) return Number(match[1]) * 1000
  } catch { /* fall back to conservative backoff */ }
  return 30_000 * (attempt + 1)
}

/** Generate one WAV per chunk using Gemini's generateContent REST API. */
export function createGeminiTtsProvider(options: { model?: string; apiKey?: string; apiKeys?: string[]; fetchImpl?: typeof fetch } = {}): TtsProvider {
  const model = options.model ?? DEFAULT_GEMINI_TTS_MODEL
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) throw new Error('Invalid Gemini TTS model ID')
  const supplied = options.apiKeys ?? (options.apiKey !== undefined ? [options.apiKey] :
    GEMINI_API_KEY_NAMES.map((name) => process.env[name]))
  const keys = [...new Set(supplied.map((key) => key?.trim()).filter((key): key is string => Boolean(key)))]
  const blockedUntil = keys.map(() => 0)
  let currentKey = 0
  return {
    id: 'gemini-tts',
    model,
    async synthesizeChunk(request, context) {
      if (!keys.length) throw new Error('Gemini TTS requires GEMINI_API_KEY')
      const voice = context.voiceId || DEFAULT_GEMINI_TTS_VOICE
      const customVoice = isGeminiCustomVoice(voice)
      if (!customVoice && !GEMINI_TTS_VOICES.includes(voice as (typeof GEMINI_TTS_VOICES)[number])) {
        throw new Error(`Unknown Gemini TTS voice: ${voice}. Choose ${GEMINI_TTS_VOICES.join(', ')} or a designed voice ID`)
      }
      const tag = request.tag ?? 'tactical'
      const cacheKey = createHash('sha256').update(JSON.stringify([
        'gemini-tts-audio-v1', model, voice, request.text, GEMINI_DELIVERY_STYLES[tag], request.attempt
      ])).digest('hex')
      const cacheFile = context.geminiCacheDir ? path.join(context.geminiCacheDir, `${cacheKey}.wav`) : undefined
      if (cacheFile) {
        const cached = await fs.readFile(cacheFile).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (cached) {
          if (cached.length < 44 || cached.toString('ascii', 0, 4) !== 'RIFF' || cached.toString('ascii', 8, 12) !== 'WAVE') {
            throw new Error('Gemini TTS resume cache contains an invalid WAV; remove the cache and retry')
          }
          context.signal?.throwIfAborted()
          await fs.writeFile(request.outputWav, cached)
          context.onGeminiCacheHit?.()
          return
        }
      }
      const body = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: request.text, speechMetadata: { style: GEMINI_DELIVERY_STYLES[tag] } }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { languageCode: 'id-ID', voiceConfig: customVoice ? { voice } : { prebuiltVoiceConfig: { voiceName: voice } } }
            }
          })
      let response: Response | undefined
      let requests = 0
      // A designed voice is project-scoped; rotating to a different project
      // could fail or use the wrong identity. Pin it to the selected first key.
      const usableCount = customVoice ? 1 : keys.length
      while (requests < usableCount * 4) {
        context.signal?.throwIfAborted()
        const now = Date.now()
        let index = -1
        for (let offset = 0; offset < usableCount; offset++) {
          const candidate = (currentKey + offset) % usableCount
          if (blockedUntil[candidate]! <= now) { index = candidate; break }
        }
        if (index < 0) {
          const waitMs = Math.max(0, Math.min(...blockedUntil.slice(0, usableCount)) - now)
          if (waitMs > 60_000) throw new Error(`Gemini TTS rate limit: retry after ${Math.ceil(waitMs / 1000)} seconds`)
          await delay(waitMs, undefined, { signal: context.signal })
          continue
        }
        const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
        response = await (options.fetchImpl ?? fetch)(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: 'POST', headers: { 'x-goog-api-key': keys[index]!, 'content-type': 'application/json' }, body, signal }
        )
        requests++
        if (response.status !== 429) { currentKey = index; break }
        const waitMs = await retryDelayMs(response, Math.floor((requests - 1) / usableCount))
        blockedUntil[index] = Date.now() + waitMs
        currentKey = (index + 1) % usableCount
      }
      if (!response) throw new Error('Gemini TTS returned no response')
      // Never print the provider response: it may contain credentials or script text.
      if (!response.ok) throw new Error(`Gemini TTS failed (HTTP ${response.status})`)
      const result = await response.json() as {
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }> } }>
      }
      const candidate = result.candidates?.[0]
      if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
        throw new Error(`Gemini TTS did not finish successfully (${candidate.finishReason})`)
      }
      const audioParts = candidate?.content?.parts?.map((part) => part.inlineData ?? (part.inline_data && { mimeType: part.inline_data.mime_type, data: part.inline_data.data })).filter(Boolean) ?? []
      if (audioParts.length !== 1) throw new Error('Gemini TTS returned no single WAV audio response')
      const audio = audioParts[0]!
      if (audio.mimeType?.toLowerCase().split(';')[0]?.trim() !== 'audio/wav' || !audio.data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio.data)) {
        throw new Error('Gemini TTS returned invalid or unsupported WAV audio')
      }
      const bytes = Buffer.from(audio.data, 'base64')
      if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Gemini TTS returned an invalid WAV container')
      }
      context.signal?.throwIfAborted()
      if (cacheFile && context.geminiCacheDir) {
        await fs.mkdir(context.geminiCacheDir, { recursive: true })
        const temporary = path.join(context.geminiCacheDir, `.${randomUUID()}.tmp`)
        try {
          await fs.writeFile(temporary, bytes, { flag: 'wx' })
          await fs.link(temporary, cacheFile).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error
          })
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => undefined)
        }
      }
      await fs.writeFile(request.outputWav, bytes)
    },
    stop() { /* no persistent connection */ }
  }
}
