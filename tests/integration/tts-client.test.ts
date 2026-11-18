import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  parseFrameHeaders,
  synthesizeEdgeTts,
  TtsCancelledError,
  type EdgeHttpResponse,
  type EdgeSocket,
  type SocketFactory
} from '../../src/core/tts/net/edge-tts-client'
import { synthesizeSpeech } from '../../src/core/tts/synthesize'
import { resolveFfmpegBinariesCached } from '../../src/core/ffmpeg/resolve-bin'
import { runFfmpeg } from '../../src/core/ffmpeg/runner'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

/**
 * Hermetic for the network (the client's socket is injected — the same
 * pattern the downloader tests use with `fetchImpl`); the sentence-stitch
 * half uses the real ffmpeg binaries, like compress.test.ts.
 */

type Listener = (...args: never[]) => void

class FakeSocket implements EdgeSocket {
  readonly url: string
  readonly headers: Record<string, string>
  sent: string[] = []
  terminated = false
  private listeners = new Map<string, Set<Listener>>()

  constructor(url: string, headers: Record<string, string>) {
    this.url = url
    this.headers = headers
  }

  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    /* tests observe state via emissions */
  }
  terminate(): void {
    this.terminated = true
  }
  on(event: string, cb: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(cb)
    return this
  }
  removeAllListeners(): this {
    this.listeners.clear()
    return this
  }
  emit(event: string, ...args: never[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args)
  }

  emitOpen(): void {
    this.emit('open')
  }
  /** Binary frame: 2-byte BE header length, headers ending Path:audio, payload. */
  emitAudio(payload: Buffer): void {
    const header = Buffer.from(
      'X-RequestId:test\r\nContent-Type:application/octet-stream\r\nPath:audio\r\n',
      'utf8'
    )
    const prefix = Buffer.alloc(2)
    prefix.writeUInt16BE(header.length)
    this.emit('message', Buffer.concat([prefix, header, payload]), true)
  }
  /** Text frame: header block, CRLFCRLF, JSON body. */
  emitText(messagePath: string, json = '{}'): void {
    const text =
      `X-RequestId:test\r\nContent-Type:application/json; charset=utf-8\r\n` +
      `Path:${messagePath}\r\n\r\n${json}`
    this.emit('message', Buffer.from(text, 'utf8'), false)
  }
  emitClose(code: number): void {
    this.emit('close', code, Buffer.from(''))
  }
  emitUnexpectedResponse(res: EdgeHttpResponse): void {
    this.emit('unexpected-response', {} as never, res as never)
  }
  /** Drive a full successful synthesis: open → audio → turn.end. */
  complete(payload: Buffer): void {
    this.emitOpen()
    this.emitAudio(payload)
    this.emitText('turn.end')
  }
}

function harness(): { fakes: FakeSocket[]; factory: SocketFactory } {
  const fakes: FakeSocket[] = []
  const factory: SocketFactory = (url, headers) => {
    const fake = new FakeSocket(url, headers)
    fakes.push(fake)
    return fake
  }
  return { fakes, factory }
}

/** Let attempt() run its executor and register listeners on the fake. */
const registered = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * The orchestrator creates its scratch dir (real I/O) before the first socket
 * and synthesizes sentences sequentially — wait until socket #n exists.
 */
const untilSocket = async (fakes: FakeSocket[], n: number): Promise<void> => {
  for (let i = 0; i < 100 && fakes.length < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(fakes.length).toBeGreaterThanOrEqual(n)
  await registered()
}

describe('parseFrameHeaders', () => {
  it('parses CRLF header lines', () => {
    expect(parseFrameHeaders('Path:audio\r\nX-RequestId:abc')).toEqual({
      Path: 'audio',
      'X-RequestId': 'abc'
    })
  })
})

describe('edge tts client', () => {
  it('connects to the allow-listed host with the Edge handshake', async () => {
    const { fakes, factory } = harness()
    const promise = synthesizeEdgeTts({ ssml: '<speak>hai</speak>', socketFactory: factory })
    await registered()
    fakes[0].complete(Buffer.from('mp3'))
    await promise

    expect(fakes[0].url.startsWith('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?')).toBe(true)
    expect(fakes[0].url).toContain('Sec-MS-GEC=')
    expect(fakes[0].url).toContain('Sec-MS-GEC-Version=2-')
    expect(fakes[0].url).toContain('TrustedClientToken=')
    expect(fakes[0].url).toContain('ConnectionId=')
    expect(fakes[0].headers.Origin).toContain('chrome-extension://')
    expect(fakes[0].headers['User-Agent']).toContain('Edg/')
  })

  it('sends speech.config then the ssml, and stitches audio frames', async () => {
    const { fakes, factory } = harness()
    const promise = synthesizeEdgeTts({
      ssml: '<speak xmlns="x">bernanapas</speak>',
      socketFactory: factory
    })
    await registered()
    fakes[0].emitOpen()
    await registered()
    expect(fakes[0].sent.length).toBe(2)
    expect(fakes[0].sent[0]).toContain('Path:speech.config')
    expect(fakes[0].sent[0]).toContain('audio-24khz-48kbitrate-mono-mp3')
    expect(fakes[0].sent[1]).toContain('Path:ssml')
    expect(fakes[0].sent[1]).toContain('bernanapas')
    // The request id is the reference library's 32-hex shape.
    expect(fakes[0].sent[1]).toMatch(/X-RequestId:[0-9a-f]{32}\r\n/)

    fakes[0].emitAudio(Buffer.from('mp3-a'))
    fakes[0].emitAudio(Buffer.from('mp3-b'))
    fakes[0].emitText('audio.metadata') // noise: not turn.end
    fakes[0].emitText('turn.end')
    const result = await promise
    expect(result.audio.toString()).toBe('mp3-amp3-b')
    expect(result.bytes).toBe(10)
  })

  it('rejects when turn.end arrives with no audio', async () => {
    const { fakes, factory } = harness()
    const promise = synthesizeEdgeTts({ ssml: '<speak/>', socketFactory: factory })
    await registered()
    fakes[0].emitOpen()
    await registered()
    fakes[0].emitText('turn.end')
    await expect(promise).rejects.toThrow('no audio')
  })

  it('rejects on early close with a readable message', async () => {
    const { fakes, factory } = harness()
    const promise = synthesizeEdgeTts({ ssml: '<speak/>', socketFactory: factory })
    await registered()
    fakes[0].emitClose(1000)
    await expect(promise).rejects.toThrow('closed before the audio finished')
  })

  it('retries a 403 handshake once with the server clock', async () => {
    const { fakes, factory } = harness()
    const promise = synthesizeEdgeTts({ ssml: '<speak>hai</speak>', socketFactory: factory })
    await registered()
    fakes[0].emitUnexpectedResponse({
      statusCode: 403,
      headers: { date: 'Wed, 18 Nov 2026 10:00:00 GMT' }
    })
    await registered()
    expect(fakes.length).toBe(2) // one retry, not a loop
    expect(fakes[0].terminated).toBe(true)
    fakes[1].complete(Buffer.from('ok'))
    const result = await promise
    expect(result.audio.toString()).toBe('ok')
  })

  it('does not retry a non-403 handshake failure', async () => {
    const { fakes, factory } = harness()
    const promise = synthesizeEdgeTts({ ssml: '<speak/>', socketFactory: factory })
    await registered()
    fakes[0].emitUnexpectedResponse({ statusCode: 503, headers: {} })
    await expect(promise).rejects.toThrow('handshake failed (503)')
    expect(fakes.length).toBe(1)
  })

  it('abort rejects with TtsCancelledError and terminates the socket', async () => {
    const { fakes, factory } = harness()
    const controller = new AbortController()
    const promise = synthesizeEdgeTts({
      ssml: '<speak/>',
      signal: controller.signal,
      socketFactory: factory
    })
    await registered()
    controller.abort()
    await expect(promise).rejects.toThrow(TtsCancelledError)
    expect(fakes[0].terminated).toBe(true)
  })
})

describe('synthesizeSpeech orchestration', () => {
  // The stitch runs REAL ffmpeg, so the fake sockets must carry real MP3
  // bytes — one tiny 24 kHz mono file, reused as every "sentence".
  let realMp3: Buffer = Buffer.alloc(0)
  beforeAll(async () => {
    const dir = await makeScratchDir('tts-fixture')
    try {
      const { ffmpegPath } = await resolveFfmpegBinariesCached()
      const file = path.join(dir, 'sentence.mp3')
      const result = await runFfmpeg({
        ffmpegPath,
        args: ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.2', '-c:a', 'libmp3lame', '-b:a', '48k', file],
        durationSec: 0.2
      })
      expect(result.code).toBe(0)
      realMp3 = await readFile(file)
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('writes a single sentence straight to disk without ffmpeg', async () => {
    const dir = await makeScratchDir('tts')
    try {
      const out = path.join(dir, 'satu.mp3')
      const { fakes, factory } = harness()
      const promise = synthesizeSpeech({
        text: 'Satu kalimat saja.',
        voiceId: 'rimba',
        outputPath: out,
        ffmpegPath: 'unused-for-single-sentence',
        socketFactory: factory
      })
      await registered()
      expect(fakes.length).toBe(1)
      fakes[0].complete(Buffer.from('mp3-bytes'))
      const result = await promise
      expect(result.path).toBe(out)
      expect((await readFile(out)).toString()).toBe('mp3-bytes')
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('synthesizes each sentence and stitches preset pauses with ffmpeg', async () => {
    const dir = await makeScratchDir('tts')
    const { ffmpegPath } = await resolveFfmpegBinariesCached()
    try {
      const out = path.join(dir, 'narasi.mp3')
      const { fakes, factory } = harness()
      const promise = synthesizeSpeech({
        text: 'Satu. Dua.',
        voiceId: 'rimba',
        outputPath: out,
        ffmpegPath,
        socketFactory: factory
      })
      await untilSocket(fakes, 1)
      // Open triggers the speech.config + ssml sends; assert before the turn ends.
      fakes[0].emitOpen()
      await registered()
      // Sentence 1: SSML carries the preset voice + prosody, no breaks.
      expect(fakes[0].sent[1]).toContain('id-ID-ArdiNeural')
      expect(fakes[0].sent[1]).toContain('rate="-10%"')
      expect(fakes[0].sent[1]).not.toContain('<break')
      fakes[0].emitAudio(realMp3)
      fakes[0].emitText('turn.end')
      await untilSocket(fakes, 2)
      expect(fakes.length).toBe(2) // one socket per sentence
      fakes[1].complete(realMp3)
      const result = await promise
      expect(result.path).toBe(out)
      // Re-encoded by ffmpeg: a valid MP3 (ID3 tag or MPEG frame sync).
      const bytes = await readFile(out)
      expect(
        bytes.subarray(0, 3).toString('ascii') === 'ID3' || bytes[0] === 0xff
      ).toBe(true)
      expect(result.bytes).toBe(bytes.length)
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('rejects empty text and unknown voices before any socket opens', async () => {
    const { fakes, factory } = harness()
    await expect(
      synthesizeSpeech({ text: '   ', voiceId: 'rimba', outputPath: 'x.mp3', ffmpegPath: 'x', socketFactory: factory })
    ).rejects.toThrow('Enter some text')
    await expect(
      synthesizeSpeech({ text: 'hai', voiceId: 'nope', outputPath: 'x.mp3', ffmpegPath: 'x', socketFactory: factory })
    ).rejects.toThrow('Unknown voice')
    expect(fakes.length).toBe(0)
  })
})
