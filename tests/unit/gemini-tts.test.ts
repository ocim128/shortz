import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGeminiTtsProvider, GEMINI_DELIVERY_STYLES } from '../../src/core/tts/gemini-tts'
import { INVESTIGATOR_VOICE_ID } from '../../src/shared/tts/gemini'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

function wav(): Buffer {
  const bytes = Buffer.alloc(48)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36)
  bytes.writeUInt32LE(4, 40)
  return bytes
}

describe('Gemini TTS provider', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to the selected Investigator voice', async () => {
    const dir = await makeScratchDir('gemini-default')
    try {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: {
        mimeType: 'audio/wav', data: wav().toString('base64')
      } }] } }] }), { status: 200 }))
      const provider = createGeminiTtsProvider({ apiKey: 'fake', fetchImpl: fetchMock as typeof fetch })
      await provider.synthesizeChunk({ text: 'Halo.', chunkIndex: 0, attempt: 0, outputWav: path.join(dir, 'out.wav') }, { voiceId: '', ffmpegPath: '' })
      const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(JSON.parse(String(options.body)).generationConfig.speechConfig.voiceConfig).toEqual({ voice: INVESTIGATOR_VOICE_ID })
    } finally { await removeScratchDir(dir) }
  })

  it.each(['hook', 'tactical', 'twist'] as const)('sends %s style as metadata and preserves WAV bytes', async (tag) => {
    const dir = await makeScratchDir('gemini-tts')
    try {
      const audio = wav()
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP',
        content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } }] } }] }), { status: 200 }))
      const provider = createGeminiTtsProvider({ apiKey: 'fake-key', model: 'gemini-3.8-flash-lite-tts', fetchImpl: fetchMock as typeof fetch })
      const output = path.join(dir, 'out.wav')
      const transcript = 'Air tinggal setengah botol.'
      await provider.synthesizeChunk({ text: transcript, tag, chunkIndex: 0, attempt: 0, outputWav: output }, { voiceId: 'Fenrir', ffmpegPath: '' })
      const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent')
      expect(options.headers).toMatchObject({ 'x-goog-api-key': 'fake-key' })
      const body = JSON.parse(String(options.body))
      expect(body.contents[0].parts).toEqual([{ text: transcript, speechMetadata: { style: GEMINI_DELIVERY_STYLES[tag] } }])
      expect(body.generationConfig).toEqual({ responseModalities: ['AUDIO'], speechConfig: {
        languageCode: 'id-ID', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Fenrir' } }
      } })
      expect(await readFile(output)).toEqual(audio)
    } finally { await removeScratchDir(dir) }
  })

  it('fails safely for missing credentials, invalid voice, and unsuccessful HTTP status', async () => {
    vi.stubEnv('GEMINI_API_KEY', '')
    const fetchMock = vi.fn(async () => new Response('', { status: 403 }))
    const request = { text: 'Halo.', chunkIndex: 0, attempt: 0, outputWav: 'unused.wav' }
    await expect(createGeminiTtsProvider({ fetchImpl: fetchMock as typeof fetch }).synthesizeChunk(request, { voiceId: 'Charon', ffmpegPath: '' })).rejects.toThrow('GEMINI_API_KEY')
    const provider = createGeminiTtsProvider({ apiKey: 'fake-key', fetchImpl: fetchMock as typeof fetch })
    await expect(provider.synthesizeChunk(request, { voiceId: 'invalid', ffmpegPath: '' })).rejects.toThrow('Unknown Gemini')
    await expect(provider.synthesizeChunk(request, { voiceId: 'Charon', ffmpegPath: '' })).rejects.toThrow('HTTP 403')
  })

  it('retries rate limiting using Google retry guidance', async () => {
    const dir = await makeScratchDir('gemini-retry')
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav().toString('base64') } }] } }] }), { status: 200 }))
      const output = path.join(dir, 'out.wav')
      await createGeminiTtsProvider({ apiKey: 'fake', fetchImpl: fetchMock as typeof fetch }).synthesizeChunk(
        { text: 'Halo.', chunkIndex: 0, attempt: 0, outputWav: output }, { voiceId: 'Charon', ffmpegPath: '' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(await readFile(output)).toEqual(wav())
    } finally { await removeScratchDir(dir) }
  })

  it('returns long quota reset times without repeatedly calling the API', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { details: [{ retryDelay: '3600s' }] } }), { status: 429 }))
    const provider = createGeminiTtsProvider({ apiKey: 'fake', fetchImpl: fetchMock as typeof fetch })
    await expect(provider.synthesizeChunk({ text: 'Halo.', chunkIndex: 0, attempt: 0, outputWav: 'unused.wav' },
      { voiceId: 'Charon', ffmpegPath: '' })).rejects.toThrow('retry after 3600 seconds')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('switches to the next unique key on 429 and keeps using it', async () => {
    const dir = await makeScratchDir('gemini-keys')
    try {
      const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav().toString('base64') } }] } }] }), { status: 200 })
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '3600' } }))
        .mockImplementation(async () => ok())
      const provider = createGeminiTtsProvider({ apiKeys: ['first', 'first', 'second', 'third'], fetchImpl: fetchMock as typeof fetch })
      const output = path.join(dir, 'out.wav')
      const request = { text: 'Halo.', chunkIndex: 0, attempt: 0, outputWav: output }
      await provider.synthesizeChunk(request, { voiceId: 'Charon', ffmpegPath: '' })
      await provider.synthesizeChunk(request, { voiceId: 'Charon', ffmpegPath: '' })
      const used = fetchMock.mock.calls.map((call) => (call[1] as RequestInit).headers as Record<string, string>)
      expect(used.map((headers) => headers['x-goog-api-key'])).toEqual(['first', 'second', 'second'])
    } finally { await removeScratchDir(dir) }
  })

  it('does not switch keys on an authentication failure', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 403 }))
    const provider = createGeminiTtsProvider({ apiKeys: ['first', 'second'], fetchImpl: fetchMock as typeof fetch })
    await expect(provider.synthesizeChunk({ text: 'Halo.', chunkIndex: 0, attempt: 0, outputWav: 'unused.wav' },
      { voiceId: 'Charon', ffmpegPath: '' })).rejects.toThrow('HTTP 403')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the custom voice field and pins designed voices to one project key', async () => {
    const dir = await makeScratchDir('gemini-custom-voice')
    try {
      const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: {
        mimeType: 'audio/wav', data: wav().toString('base64')
      } }] } }] }), { status: 200 })
      const fetchMock = vi.fn().mockImplementationOnce(async () => ok())
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '3600' } }))
      const provider = createGeminiTtsProvider({ apiKeys: ['owner-key', 'other-project-key'], fetchImpl: fetchMock as typeof fetch })
      const output = path.join(dir, 'out.wav')
      const request = { text: 'Halo.', chunkIndex: 0, attempt: 0, outputWav: output }
      await provider.synthesizeChunk(request, { voiceId: 'voice_abc123', ffmpegPath: '' })
      const sent = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
      expect(sent.generationConfig.speechConfig.voiceConfig).toEqual({ voice: 'voice_abc123' })
      await expect(provider.synthesizeChunk(request, { voiceId: 'voice_abc123', ffmpegPath: '' })).rejects.toThrow('rate limit')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'owner-key' })
    } finally { await removeScratchDir(dir) }
  })

  it('rejects invalid WAVs and incomplete generations without overwriting output', async () => {
    const dir = await makeScratchDir('gemini-invalid')
    try {
      const output = path.join(dir, 'out.wav')
      await writeFile(output, 'existing')
      const makeResponse = (payload: unknown) => vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch
      const request = { text: 'Halo.', chunkIndex: 0, attempt: 0, outputWav: output }
      const context = { voiceId: 'Charon', ffmpegPath: '' }
      const badWav = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from('bad').toString('base64') } }] } }] }
      await expect(createGeminiTtsProvider({ apiKey: 'fake', fetchImpl: makeResponse(badWav) }).synthesizeChunk(request, context)).rejects.toThrow('invalid WAV')
      const incomplete = { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }
      await expect(createGeminiTtsProvider({ apiKey: 'fake', fetchImpl: makeResponse(incomplete) }).synthesizeChunk(request, context)).rejects.toThrow('MAX_TOKENS')
      expect(await readFile(output, 'utf8')).toBe('existing')
    } finally { await removeScratchDir(dir) }
  })
})
