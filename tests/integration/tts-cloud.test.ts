import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudProvider } from '../../src/core/tts/provider'
import { resolveFfmpegBinariesCached } from '../../src/core/ffmpeg/resolve-bin'
import { runFfmpeg } from '../../src/core/ffmpeg/runner'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

describe('cloud speech provider', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('sends a configured ElevenLabs request and converts its MP3 into a WAV', async () => {
    const dir = await makeScratchDir('cloud-tts')
    try {
      const { ffmpegPath } = await resolveFfmpegBinariesCached()
      const source = path.join(dir, 'source.mp3')
      const encoded = await runFfmpeg({ ffmpegPath, durationSec: 1,
        args: ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', source] })
      expect(encoded.code).toBe(0)
      const bytes = await readFile(source)
      vi.stubEnv('ELEVENLABS_API_KEY', 'test-key')
      vi.stubEnv('ELEVENLABS_VOICE_ID', 'voice-id')
      const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }))
      const provider = createCloudProvider({ fetchImpl: fetchMock as typeof fetch })
      const output = path.join(dir, 'out.wav')
      await provider.synthesizeChunk({ text: 'Air tinggal sedikit.', chunkIndex: 0, attempt: 0, outputWav: output },
        { voiceId: 'voice-id', ffmpegPath })
      const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain('/v1/text-to-speech/voice-id?')
      expect(JSON.parse(String(options.body))).toMatchObject({ text: 'Air tinggal sedikit.', model_id: 'eleven_multilingual_v2' })
      expect((await readFile(output)).toString('ascii', 0, 4)).toBe('RIFF')
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('fails before network access if configuration is missing', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '')
    vi.stubEnv('ELEVENLABS_VOICE_ID', '')
    const fetchMock = vi.fn()
    const provider = createCloudProvider({ fetchImpl: fetchMock as typeof fetch })
    await expect(provider.synthesizeChunk({ text: 'Halo', chunkIndex: 0, attempt: 0, outputWav: 'unused.wav' },
      { voiceId: '', ffmpegPath: 'unused' })).rejects.toThrow('ELEVENLABS_API_KEY')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
