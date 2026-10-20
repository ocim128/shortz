/**
 * The ONLY place the downloader touches the network (dependency policy
 * amendment, 03-tech-stack.md §"Dependency policy amendment").
 *
 * Rules enforced here, before a socket opens:
 *  - resolve/JSON: exact host allow-list (`cdn.syndication.twimg.com`,
 *    `publish.twitter.com`, `t.co`, `x.com`/`twitter.com` for the redirect hop,
 *    `api.fxtwitter.com` only when the fallback is enabled);
 *  - media: HTTPS only and `twimg.com` / `*.twimg.com`, dot-anchored (AUDIT A11);
 *  - no cookies, no credentials, no referer, a minimal user agent;
 *  - redirects off (`redirect: 'manual'`) except for the `t.co` hop and the
 *    failure-path probe;
 *  - timeouts composed with the job's own signal (D-A11): resolve 15 s total,
 *    media 5 s to the first response header then 30 s idle between body chunks.
 *
 * Everything is injectable (`fetchImpl`) so the tests are hermetic: a real
 * `Response` built from a fixture, no network.
 */

import { promises as fs } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DlError } from '../../../shared/downloader/errors'
import { isAllowedMediaUrl } from '../../../shared/downloader/urls'
import { atomicWriteFile } from '../../store/fs-utils'

export const RESOLVE_TIMEOUT_MS = 15_000
export const MEDIA_HEADER_TIMEOUT_MS = 5_000
export const MEDIA_IDLE_TIMEOUT_MS = 30_000

/** Hosts a JSON GET may reach. Exact match after stripping `www.`/`mobile.`. */
const RESOLVE_HOSTS = new Set([
  'cdn.syndication.twimg.com',
  'api.fxtwitter.com',
  'publish.twitter.com',
  't.co',
  'x.com',
  'twitter.com'
])

export interface DlClient {
  getJson(url: string, opts?: { signal?: AbortSignal }): Promise<unknown>
  expandTco(url: string, opts?: { signal?: AbortSignal }): Promise<string>
  streamTo(
    url: string,
    dest: string,
    opts: {
      signal: AbortSignal
      offset?: number
      ifRange?: string | null
      /** Additive (see NOTES-A): per-chunk progress for the orchestrator. */
      onProgress?: (delta: number, total: number | null) => void
      /** Additive (see NOTES-A): where to persist the resume validator, written
       * as soon as the response headers are known — so an interrupted transfer
       * can resume with `If-Range` instead of restarting. */
      validatorPath?: string
    }
  ): Promise<{ bytes: number; total: number | null; etag: string | null; lastModified: string | null }>
  /**
   * Additive (see NOTES-A): the failure-path probe's status, with at most one
   * redirect followed. `publish.twitter.com/oembed` answers 200 for an alive post
   * and 404 for a gone one — the only way to tell "deleted" from "sensitive".
   */
  probeStatus(url: string, opts?: { signal?: AbortSignal }): Promise<number>
}

export interface DlClientConfig {
  fetchImpl?: typeof fetch
  fallback: 'off' | 'fxtwitter' | 'auto'
  userAgent?: string
}

const DEFAULT_USER_AGENT = 'ShortZ/0.0.1 (+local desktop app)'

function bareHost(hostname: string): string {
  const host = hostname.toLowerCase()
  if (host.startsWith('www.')) return host.slice(4)
  if (host.startsWith('mobile.')) return host.slice(7)
  return host
}

function parseUrl(url: string): URL {
  try {
    return new URL(url)
  } catch {
    throw new DlError('URL_UNRECOGNIZED', `not a URL: ${url}`)
  }
}

/** The resolve allow-list, enforced before the request is built. */
export function isAllowedResolveUrl(url: string, fallback: 'off' | 'fxtwitter' | 'auto'): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = bareHost(parsed.hostname)
  if (!RESOLVE_HOSTS.has(host)) return false
  if (host === 'api.fxtwitter.com' && fallback === 'off') return false
  return true
}

/** `Retry-After`: seconds (int/float) or an HTTP-date. Absent/invalid → null. */
export function parseRetryAfter(header: string | null | undefined, nowMs = Date.now()): number | null {
  if (header === null || header === undefined) return null
  const value = header.trim()
  if (value.length === 0) return null
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000)
  // Only a date-like value may go through Date.parse: `Date.parse('-5')` happily
  // returns a year instead of NaN, which would become a bogus pause.
  if (!/[A-Za-z]{3}/.test(value)) return null
  const at = Date.parse(value)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - nowMs)
}

/** Total size from a Content-Range header (`bytes 200-1023/4096` or `bytes 4096` form). */
export function contentRangeTotal(header: string | null | undefined): number | null {
  if (header === null || header === undefined) return null
  const match = /\/(\d+)\s*$/.exec(header.trim())
  return match === null ? null : Number(match[1])
}

function contentLength(res: Response): number | null {
  const raw = res.headers.get('content-length')
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function isTimeoutError(error: unknown): boolean {
  return (error as { name?: string } | null | undefined)?.name === 'TimeoutError'
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null | undefined)?.name === 'AbortError'
}

/** Map a transport failure; a caller-initiated abort stays an AbortError (cancel). */
function mapTransportError(error: unknown, signal?: AbortSignal): never {
  if (error instanceof DlError) throw error
  if (isAbort(error)) {
    if (signal?.aborted === true) throw error
    throw new DlError('NETWORK', 'request aborted')
  }
  if (isTimeoutError(error)) throw new DlError('NETWORK', 'request timed out')
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  throw new DlError('NETWORK', code === undefined ? message : `${code}: ${message}`)
}

/** Free the socket for a response we are not going to read. */
function discard(res: Response): void {
  void res.body?.cancel().catch(() => undefined)
}

function statusError(res: Response, what: string): DlError | null {
  const status = res.status
  if (status === 429) {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
    return new DlError(
      'RATE_LIMITED',
      `429 (retry-after: ${retryAfter === null ? 'absent' : `${retryAfter} ms`})`,
      retryAfter === null ? {} : { retryAfterMs: retryAfter }
    )
  }
  if (status === 401) return new DlError('AUTH_REQUIRED', `${what}: 401`)
  if (status === 403) return new DlError('AUTH_REQUIRED', `${what}: 403`)
  if (status === 404) return new DlError('NOT_FOUND', `${what}: 404`)
  if (status >= 500) return new DlError('UPSTREAM_ERROR', `${what}: ${status}`)
  if (status < 200 || status >= 300) return new DlError('UPSTREAM_ERROR', `${what}: ${status}`)
  return null
}

/** Race a promise against a timer that aborts `controller` with a NETWORK error. */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  ms: number,
  detail: string
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DlError('NETWORK', detail))
  }, ms)
  const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal])
  try {
    return await work(signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read the response body as an async iterable, re-arming an idle timer per chunk
 * (AUDIT A20 / D-A11): a dead network fails a line in seconds, not minutes.
 */
async function* bodyChunks(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  signal: AbortSignal
): AsyncGenerator<Buffer> {
  const reader = body.getReader()
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new DlError('NETWORK', `no body data for ${idleMs} ms`))
        }, idleMs)
      })
      const read = reader.read().catch((error: unknown) => {
        if (error instanceof DlError) throw error
        if (isAbort(error) && signal.aborted) throw error
        throw new DlError('NETWORK', error instanceof Error ? error.message : String(error))
      })
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await Promise.race([read, timeout])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (result.done === true) return
      if (result.value !== undefined) yield Buffer.from(result.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export function createDlClient(config: DlClientConfig): DlClient {
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT

  function assertResolveAllowed(url: string): void {
    if (!isAllowedResolveUrl(url, config.fallback)) {
      throw new DlError('URL_UNRECOGNIZED', `host not allowed: ${url.slice(0, 80)}`)
    }
  }

  async function getJson(url: string, opts: { signal?: AbortSignal } = {}): Promise<unknown> {
    assertResolveAllowed(url)
    const res = await withTimeout(
      (signal) =>
        fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: { accept: 'application/json', 'user-agent': userAgent },
          signal
        }).catch((error: unknown) => mapTransportError(error, opts.signal)),
      opts.signal,
      RESOLVE_TIMEOUT_MS,
      'resolve timed out after 15 s'
    )
    const failure = statusError(res, 'resolve')
    if (failure !== null) {
      discard(res)
      throw failure
    }
    let parsed: unknown
    try {
      parsed = await res.json()
    } catch (error) {
      throw new DlError(
        'UPSTREAM_ERROR',
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return parsed
  }

  async function expandTco(url: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const parsed = parseUrl(url)
    if (bareHost(parsed.hostname) !== 't.co') {
      throw new DlError('URL_UNRECOGNIZED', `not a t.co link: ${url.slice(0, 80)}`)
    }
    const res = await withTimeout(
      (signal) =>
        fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: { 'user-agent': userAgent },
          signal
        }).catch((error: unknown) => mapTransportError(error, opts.signal)),
      opts.signal,
      RESOLVE_TIMEOUT_MS,
      't.co expansion timed out after 15 s'
    )
    discard(res)
    const failure = res.status >= 400 ? statusError(res, 't.co') : null
    if (failure !== null) throw failure
    const location = res.headers.get('location')
    if (location === null || location.length === 0) {
      throw new DlError('UPSTREAM_ERROR', `t.co did not redirect (${res.status})`)
    }
    return location
  }

  async function probeStatus(
    url: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<number> {
    assertResolveAllowed(url)
    const first = await withTimeout(
      (signal) =>
        fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: { accept: 'application/json', 'user-agent': userAgent },
          signal
        }).catch((error: unknown) => mapTransportError(error, opts.signal)),
      opts.signal,
      RESOLVE_TIMEOUT_MS,
      'probe timed out after 15 s'
    )
    discard(first)
    if (first.status < 300 || first.status >= 400) return first.status
    const location = first.headers.get('location')
    if (location === null) return first.status
    // "follow at most one redirect"
    const second = await withTimeout(
      (signal) =>
        fetchImpl(new URL(location, url).toString(), {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: { accept: 'application/json', 'user-agent': userAgent },
          signal
        }).catch((error: unknown) => mapTransportError(error, opts.signal)),
      opts.signal,
      RESOLVE_TIMEOUT_MS,
      'probe redirect timed out'
    )
    discard(second)
    return second.status
  }

  async function streamTo(
    url: string,
    dest: string,
    opts: {
      signal: AbortSignal
      offset?: number
      ifRange?: string | null
      onProgress?: (delta: number, total: number | null) => void
      validatorPath?: string
    }
  ): Promise<{ bytes: number; total: number | null; etag: string | null; lastModified: string | null }> {
    // Belt and braces (D-A9): the engine checks too, but a hostile URL must never
    // reach a socket even if a future caller forgets.
    if (!isAllowedMediaUrl(url)) {
      throw new DlError('URL_UNRECOGNIZED', `media host not allowed: ${url.slice(0, 80)}`)
    }

    let offset = Math.max(0, opts.offset ?? 0)
    let ifRange = offset > 0 ? (opts.ifRange ?? null) : null

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ranged = offset > 0
      const headers: Record<string, string> = {
        // AUDIT A12: undici negotiates gzip transparently, so Content-Length would
        // describe the ENCODED body and the exact-size check would misfire.
        'accept-encoding': 'identity',
        accept: '*/*',
        'user-agent': userAgent
      }
      if (ranged) headers.range = `bytes=${offset}-`
      if (ifRange !== null) headers['if-range'] = ifRange

      const res = await withTimeout(
        (signal) =>
          fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            headers,
            signal
          }).catch((error: unknown) => mapTransportError(error, opts.signal)),
        opts.signal,
        MEDIA_HEADER_TIMEOUT_MS,
        'no response headers within 5 s'
      )

      if (res.status === 416) {
        const total = contentRangeTotal(res.headers.get('content-range'))
        discard(res)
        // Interrupted exactly at 100% (AUDIT rev 2): the .part IS complete.
        if (ranged && total !== null && offset === total) {
          return { bytes: 0, total, etag: null, lastModified: null }
        }
        if (!ranged) {
          throw new DlError('UPSTREAM_ERROR', '416 for an unranged request')
        }
        // A stale .part from another encoding: drop it and restart clean.
        await fs.rm(dest, { force: true }).catch(() => undefined)
        offset = 0
        ifRange = null
        continue
      }

      if (res.status === 403) {
        discard(res)
        throw new DlError('LINK_EXPIRED', 'signed media URL returned 403')
      }
      const failure = statusError(res, 'media')
      if (failure !== null) {
        discard(res)
        throw failure
      }

      const isPartial = res.status === 206
      const resumed = isPartial && ranged
      const partialTotal = contentRangeTotal(res.headers.get('content-range'))
      const remaining = contentLength(res)
      const total = isPartial
        ? partialTotal ?? (remaining === null ? null : offset + remaining)
        : remaining
      const etag = res.headers.get('etag')
      const lastModified = res.headers.get('last-modified')
      const body = res.body
      if (body === null) {
        throw new DlError('UPSTREAM_ERROR', 'response had no body')
      }

      // Persist the resume validator BEFORE the body: an interrupt at 40 % must
      // still leave `{etag, lastModified, total}` beside the .part so the next
      // attempt can send If-Range and resume instead of restarting.
      if (opts.validatorPath !== undefined) {
        await atomicWriteFile(
          opts.validatorPath,
          JSON.stringify({ etag, lastModified, total })
        ).catch(() => undefined)
      }

      // The open mode is decided AFTER the status is known (AUDIT rev 2):
      // 'r+' without `start` would rewrite byte 0 instead of resuming.
      const fh = await fs.open(dest, resumed ? 'r+' : 'w').catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code
        throw new DlError(code === 'ENOSPC' ? 'DISK_FULL' : 'WRITE_ERROR', String(code ?? error))
      })
      let written = 0
      try {
        const sink = fh.createWriteStream({
          start: resumed ? offset : 0,
          autoClose: false
        })
        // A Transform counts progress INSIDE the pipeline: attaching a 'data'
        // listener instead would switch the source to flowing mode and race the sink.
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            written += chunk.length
            opts.onProgress?.(chunk.length, total)
            callback(null, chunk)
          }
        })
        const source = Readable.from(bodyChunks(body, MEDIA_IDLE_TIMEOUT_MS, opts.signal))
        await pipeline(source, counter, sink).catch((error: unknown) => {
          if (error instanceof DlError) throw error
          if (isAbort(error)) throw error
          const code = (error as NodeJS.ErrnoException | undefined)?.code
          if (code === 'ENOSPC') throw new DlError('DISK_FULL', 'write failed: ENOSPC')
          if (code !== undefined) throw new DlError('WRITE_ERROR', `${code}`)
          throw new DlError('NETWORK', error instanceof Error ? error.message : String(error))
        })
        // The rename is only as durable as the flush before it (D-A13).
        await fh.sync()
      } finally {
        await fh.close().catch(() => undefined)
      }
      return { bytes: written, total, etag, lastModified }
    }

    throw new DlError('UPSTREAM_ERROR', 'range restart did not settle')
  }

  return { getJson, expandTco, streamTo, probeStatus }
}
