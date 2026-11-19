import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGeminiCloudProvider } from '../../src/core/tts/gemini-cloud'
import { INVESTIGATOR_VOICE_ID } from '../../src/shared/tts/gemini'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

describe('Google Cloud Gemini narration', () => {
  it('sends the transcript and project-owned voice using Cloud credentials and preserves WAV audio', async () => {
    const dir = await makeScratchDir('gemini-cloud')
    try {
      const audio = Buffer.alloc(48)
      audio.write('RIFF', 0); audio.write('WAVE', 8)
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [
        { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } }
      ] } }] }), { status: 200 }))
      const provider = createGeminiCloudProvider({ project: 'test-project', getToken: async () => 'test-token', fetchImpl: fetchMock as typeof fetch })
      const outputWav = path.join(dir, 'narration.wav')
      await provider.synthesizeChunk({ text: 'Air tinggal setengah botol.', tag: 'tactical', chunkIndex: 0, attempt: 0, outputWav },
        { voiceId: INVESTIGATOR_VOICE_ID, ffmpegPath: '' })
      const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-3.8-flash-tts:generateContent')
      const headers = new Headers(options.headers)
      expect(headers.get('authorization')).toBe('Bearer test-token')
      expect(headers.has('x-goog-api-key')).toBe(false)
      const body = JSON.parse(String(options.body))
      expect(body.contents[0].role).toBe('user')
      expect(body.contents[0].parts[0].text).toBe('Air tinggal setengah botol.')
      expect(body.generationConfig.speechConfig.voiceConfig.voice).toBe(INVESTIGATOR_VOICE_ID)
      expect(await readFile(outputWav)).toEqual(audio)
    } finally { await removeScratchDir(dir) }
  })

  it('rejects missing and malformed Cloud project settings', () => {
    expect(() => createGeminiCloudProvider()).toThrow('SHORTZ_GOOGLE_CLOUD_PROJECT')
    expect(() => createGeminiCloudProvider({ project: '../bad' })).toThrow('SHORTZ_GOOGLE_CLOUD_PROJECT')
  })

  it('reports Google billing eligibility errors without exposing the response body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: {
      message: 'Access requires an eligible paid billing account in a supported region, subject to our terms and policies.'
    } }), { status: 403 }))
    const provider = createGeminiCloudProvider({ project: 'test-project', getToken: async () => 'test-token', fetchImpl: fetchMock as typeof fetch })
    await expect(provider.synthesizeChunk({ text: 'Halo.', chunkIndex: 0, attempt: 0, outputWav: 'unused.wav' },
      { voiceId: INVESTIGATOR_VOICE_ID, ffmpegPath: '' })).rejects.toThrow('eligible paid billing account')
  })

  it('uses the Agent Platform voice field for a prebuilt voice', async () => {
    const dir = await makeScratchDir('gemini-cloud-prebuilt')
    try {
      const audio = Buffer.alloc(48)
      audio.write('RIFF', 0); audio.write('WAVE', 8)
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } }
      ] } }] }), { status: 200 }))
      const provider = createGeminiCloudProvider({ project: 'test-project', getToken: async () => 'test-token', fetchImpl: fetchMock as typeof fetch })
      await provider.synthesizeChunk({ text: 'Halo.', chunkIndex: 0, attempt: 0, outputWav: path.join(dir, 'out.wav') },
        { voiceId: 'Charon', ffmpegPath: '' })
      const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(JSON.parse(String(options.body)).generationConfig.speechConfig.voiceConfig).toEqual({ voice: 'Charon' })
    } finally { await removeScratchDir(dir) }
  })
})
