import { randomUUID } from 'node:crypto'
import { secMsGec, TRUSTED_CLIENT_TOKEN } from './gec'

/**
 * The ONLY place the TTS feature touches the network (docs/03-tech-stack.md
 * §Dependency policy, rev 4 — mirrors the downloader's net client): a single
 * allow-listed WebSocket host, no cookies, no credentials, an Edge-matching
 * user agent, one retry with server-clock correction on a 403 handshake.
 *
 * Protocol = the Edge Read Aloud endpoint as implemented by the msedge-tts
 * reference library (v2.1.x): Sec-MS-GEC handshake token, `speech.config`
 * message, `ssml` message, binary audio frames until `turn.end`.
 *
 * Everything socket-shaped is injectable (`socketFactory`) so the integration
 * tests run against a fake with zero network.
 */

const ALLOWED_HOST = 'speech.platform.bing.com'
const SYNTHESIS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1'

/** Must stay in lockstep with the UA the service expects (Chrome/Edge 143). */
const EDGE_VERSION = '143.0.3650.96'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like ' +
  `Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0`
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'

export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'
export const DEFAULT_SYNTHESIS_TIMEOUT_MS = 20_000

export class TtsCancelledError extends Error {
  constructor() {
    super('TTS cancelled')
    this.name = 'TtsCancelledError'
  }
}

/**
 * Minimal socket surface this client uses (a structural slice of `ws`), so
 * tests inject a fake without pulling the real network stack.
 */
export interface EdgeSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  on(event: 'open', cb: () => void): this
  on(event: 'message', cb: (data: Buffer, isBinary: boolean) => void): this
  on(event: 'close', cb: (code: number, reason: Buffer) => void): this
  on(event: 'error', cb: (err: Error) => void): this
  on(
    event: 'unexpected-response',
    cb: (req: unknown, res: EdgeHttpResponse) => void
  ): this
  removeAllListeners(): this
}

export interface EdgeHttpResponse {
  statusCode?: number
  headers?: Record<string, string | string[] | undefined>
}

export type SocketFactory = (
  url: string,
  headers: Record<string, string>
) => EdgeSocket

export interface EdgeTtsResult {
  audio: Buffer
  bytes: number
}

export interface EdgeTtsOptions {
  ssml: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Clock source — real callers leave the default; the skew retry overrides it. */
  now?: () => Date
  socketFactory?: SocketFactory
}

// --- protocol framing ---------------------------------------------------------

/** Text frame boundary: header block, CRLFCRLF, then the JSON body. */
const FRAME_DELIM = '\r\n\r\n'
/** Binary audio frames: the MP3 payload starts right after this header line. */
const AUDIO_DELIM = 'Path:audio\r\n'

/** `X-Header:value` lines → map (Path, Content-Type, …). */
export function parseFrameHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\r\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

function buildSynthesisUrl(gecToken: string, connectionId: string): string {
  return (
    `wss://${ALLOWED_HOST}${SYNTHESIS_PATH}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${gecToken}&Sec-MS-GEC-Version=2-${EDGE_VERSION}` +
    `&ConnectionId=${connectionId}`
  )
}

function speechConfigMessage(): string {
  return (
    'Content-Type:application/json; charset=utf-8\r\n' +
    `Path:speech.config${FRAME_DELIM}` +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
            outputFormat: OUTPUT_FORMAT
          }
        }
      }
    })
  )
}

/** Request id = 16 random bytes as hex (the reference library's shape). */
function requestId(): string {
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0')
  ).join('')
}

function ssmlMessage(ssml: string, id: string): string {
  return (
    `X-RequestId:${id}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    `Path:ssml${FRAME_DELIM}` +
    ssml.trim()
  )
}

// --- client -------------------------------------------------------------------

function handShakeHeaders(): Record<string, string> {
  return { 'User-Agent': USER_AGENT, Origin: ORIGIN }
}

function headerValue(
  res: EdgeHttpResponse,
  name: string
): string | undefined {
  const raw = res.headers?.[name]
  if (Array.isArray(raw)) return raw[0]
  return raw
}

/** One synthesis attempt over one socket. Never retries by itself. */
function attempt(
  options: EdgeTtsOptions,
  factory: SocketFactory,
  nowFn: () => Date
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const url = buildSynthesisUrl(secMsGec(nowFn()), randomUUID())
    const socket = factory(url, handShakeHeaders())
    const chunks: Buffer[] = []
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      // Node fatal rule: an 'error' event with zero listeners crashes the
      // process. removeAllListeners() above just cleared the factory's
      // safety net, and ws DOES emit a late 'error' (e.g. terminate() during
      // CONNECTING aborts the handshake on nextTick) — so keep one no-op.
      socket.on('error', () => {})
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('Speech synthesis timed out'))),
      options.timeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS
    )
    const onAbort = (): void => {
      // finish BEFORE terminate — the fake/real socket's close event must not
      // win the race and mislabel a cancel as a network failure.
      finish(() => reject(new TtsCancelledError()))
      socket.terminate()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    socket.on('open', () => {
      socket.send(speechConfigMessage())
      socket.send(ssmlMessage(options.ssml, requestId()))
    })

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (settled) return
      if (isBinary) {
        // Binary frame: headers, then the MP3 payload directly after the
        // literal "Path:audio\r\n" line (the reference library's framing).
        const delim = data.indexOf(AUDIO_DELIM)
        if (delim < 0) return // e.g. a metadata binary — nothing to keep
        chunks.push(data.subarray(delim + AUDIO_DELIM.length))
        return
      }
      // Text frame: headers CRLFCRLF JSON — turn.end = audio complete.
      try {
        const text = data.toString('utf8')
        const delim = text.indexOf(FRAME_DELIM)
        const headers = delim >= 0 ? parseFrameHeaders(text.slice(0, delim)) : {}
        if (headers.Path === 'turn.end') {
          socket.close(1000)
          const audio = Buffer.concat(chunks)
          finish(() =>
            audio.length > 0
              ? resolve(audio)
              : reject(new Error('Speech service returned no audio'))
          )
        }
      } catch {
        // A malformed control frame never kills a synthesis that may still
        // be streaming — wait for turn.end or the timeout.
      }
    })

    socket.on('error', (err: Error) => {
      finish(() => reject(new Error(`Speech connection failed: ${err.message}`)))
      socket.terminate()
    })

    socket.on('close', (code: number) => {
      // A clean close after turn.end never reaches here (listeners removed in
      // finish), so any close now means the audio stream ended early.
      finish(() =>
        reject(
          new Error(
            code === 1006
              ? 'Speech service unreachable — check your internet connection'
              : `Speech connection closed before the audio finished (code ${code})`
          )
        )
      )
    })

    socket.on('unexpected-response', (_req: unknown, res: EdgeHttpResponse) => {
      const status = res.statusCode ?? 0
      const err = new Error(
        status === 403
          ? 'Speech service rejected the connection (403)'
          : `Speech service handshake failed (${status || 'no status'})`
      ) as HandshakeError
      err.statusCode = status
      // Server Date header = the clock the token must be bucketed from.
      const date = headerValue(res, 'date')
      if (date) {
        const serverTime = new Date(date)
        if (!Number.isNaN(serverTime.getTime())) {
          err.serverTime = serverTime
        }
      }
      finish(() => reject(err))
      socket.terminate()
    })
  })
}

// The skew/status fields ride on handshake errors via a small intersection
// type local to this module.
interface HandshakeError extends Error {
  statusCode?: number
  serverTime?: Date
}

export async function synthesizeEdgeTts(options: EdgeTtsOptions): Promise<EdgeTtsResult> {
  const factory = options.socketFactory ?? defaultSocketFactory
  const nowFn = options.now ?? (() => new Date())
  try {
    const audio = await attempt(options, factory, nowFn)
    return { audio, bytes: audio.length }
  } catch (error) {
    const handshake = error as HandshakeError
    // 403 usually means clock skew — retry once bucketed from the server's
    // own Date header (the reference library's clock-correction path).
    if (handshake.statusCode === 403 && handshake.serverTime && !options.signal?.aborted) {
      const skewMs = handshake.serverTime.getTime() - Date.now()
      const corrected = (): Date => new Date(Date.now() + skewMs)
      const audio = await attempt(options, factory, corrected)
      return { audio, bytes: audio.length }
    }
    throw error
  }
}

// Default factory — the only import of `ws`, lazily required so tests that
// inject a factory never load it.
function defaultSocketFactory(
  url: string,
  headers: Record<string, string>
): EdgeSocket {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebSocket } = require('ws') as typeof import('ws')
  const ws = new WebSocket(url, { headers })
  // Safety net: the client detaches its listeners once a synthesis settles;
  // a stray late 'error' from the transport must never crash the process
  // (an 'error' event with zero listeners is fatal in Node).
  ws.on('error', () => {})
  return ws as unknown as EdgeSocket
}
