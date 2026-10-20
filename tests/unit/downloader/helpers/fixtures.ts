/**
 * Hermetic test seams for the downloader suites: fixture payloads, a fake
 * `fetchImpl` that records every call, and a fake media server body builder.
 *
 * Lives under `tests/unit/downloader/` because `tests/helpers/**` is read-only
 * for this agent.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'downloader')

export interface FixturePayload {
  status: number
  /** The JSON body, with the `__status`/`__note` control keys removed. */
  body: unknown
}

/**
 * A fixture is ordinary JSON; `{"__status": 404}` says "the server answered 404
 * with no useful body". Hand-written minimal payloads only (D-A18): never a
 * captured real post with a real caption.
 */
export function readFixture(relativePath: string): FixturePayload {
  const raw = readFileSync(path.join(FIXTURE_ROOT, relativePath), 'utf8')
  // Windows editors love a UTF-8 BOM; JSON.parse does not (same guard as fs-utils).
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const record = { ...(parsed as Record<string, unknown>) }
    const status = typeof record.__status === 'number' ? record.__status : 200
    delete record.__status
    delete record.__note
    return { status, body: record }
  }
  return { status: 200, body: parsed }
}

/** Fixture body only (the common case: a 200 payload). */
export function readFixtureBody(relativePath: string): unknown {
  return readFixture(relativePath).body
}

export interface FakeCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

export interface FakeRoute {
  /** Substring, regexp, or predicate tested against the request URL. */
  match: string | RegExp | ((url: string) => boolean)
  /** Build the answer for one call (may inspect headers/init). */
  respond: (call: FakeCall) => Response | Promise<Response>
}

export interface FakeFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  calls: FakeCall[]
  urls: () => string[]
  count: (needle: string) => number
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {}
  const source = init?.headers
  if (source === undefined) return out
  if (typeof source === 'object' && !Array.isArray(source) && !(source instanceof Headers)) {
    for (const [key, value] of Object.entries(source as Record<string, string>)) {
      out[key.toLowerCase()] = String(value)
    }
    return out
  }
  const headers = new Headers(source as HeadersInit)
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

/**
 * A `typeof fetch` that answers from `routes` and records every call, so a test
 * can assert "zero network requests on the second run" (DA3) with no mocking
 * library.
 */
export function fakeFetch(routes: FakeRoute[]): FakeFetch {
  const calls: FakeCall[] = []

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const call: FakeCall = {
      url,
      method: init?.method ?? 'GET',
      headers: headersOf(init),
      body: init?.body ?? null
    }
    calls.push(call)
    const route = routes.find((candidate) => {
      const matcher = candidate.match
      if (typeof matcher === 'string') return url.includes(matcher)
      if (matcher instanceof RegExp) return matcher.test(url)
      return matcher(url)
    })
    if (route === undefined) {
      return new Response('no route for ' + url, { status: 599 })
    }
    return route.respond(call)
  }

  const fake = impl as FakeFetch
  fake.calls = calls
  fake.urls = () => calls.map((call) => call.url)
  fake.count = (needle) => calls.filter((call) => call.url.includes(needle)).length
  return fake
}

/** A JSON `Response` from a fixture body. */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

/** Bytes of a deterministic fake video, so size assertions are exact. */
export function fakeVideoBytes(size: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + seed) % 256
  }
  return bytes
}

/** A route answering a media GET with a full 200 body. */
export function mediaRoute(
  body: Uint8Array,
  options: { etag?: string; lastModified?: string; contentType?: string } = {}
): FakeRoute {
  return {
    match: (url: string) => url.startsWith('https://'),
    respond: () =>
      new Response(body as unknown as BodyInit, {
        status: 200,
        headers: {
          'content-type': options.contentType ?? 'video/mp4',
          'content-length': String(body.byteLength),
          ...(options.etag === undefined ? {} : { etag: options.etag }),
          ...(options.lastModified === undefined ? {} : { 'last-modified': options.lastModified })
        }
      })
  }
}

export interface RangeRouteOptions {
  etag?: string
  /** Refuse to resume: always answer 200 to a ranged request. */
  ignoreRange?: boolean
  /** Fail the first N requests with this status (before serving any bytes). */
  failFirst?: number
  failStatus?: number
  /** Overrides the total reported by a 416 (the `bytes` asterisk-slash n form). */
  rangeTotal?: number
}

/**
 * A media route that speaks the same Range dialect as Twimg: 206 + Content-Range
 * for a satisfiable range, 416 past the end, 200 when `If-Range` no longer
 * matches. This is what the resume tests assert against.
 */
export function rangeMediaRoute(body: Uint8Array, options: RangeRouteOptions = {}): FakeRoute {
  const size = body.byteLength
  const etag = options.etag ?? '"media-v1"'
  let served = 0
  return {
    match: (url: string) => url.startsWith('https://video.twimg.com/'),
    respond: (call) => {
      served += 1
      if (options.failFirst !== undefined && served <= options.failFirst) {
        return new Response(null, { status: options.failStatus ?? 503 })
      }
      const range = call.headers.range
      const ifRange = call.headers['if-range']
      if (range === undefined || options.ignoreRange === true) {
        return new Response(body as unknown as BodyInit, {
          status: 200,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(size),
            etag,
            'accept-ranges': 'bytes'
          }
        })
      }
      if (ifRange !== undefined && ifRange !== etag) {
        // The validator changed between attempts: full body, no resume.
        return new Response(body as unknown as BodyInit, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(size), etag }
        })
      }
      const start = Number.parseInt(range.replace(/^bytes=/, '').split('-')[0] ?? '0', 10)
      if (!Number.isFinite(start) || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${options.rangeTotal ?? size}` }
        })
      }
      const slice = body.slice(start)
      return new Response(slice as unknown as BodyInit, {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(slice.byteLength),
          'content-range': `bytes ${start}-${size - 1}/${size}`,
          etag,
          'accept-ranges': 'bytes'
        }
      })
    }
  }
}

/** A 200 whose body dies after `cutAt` bytes — the mid-transfer network failure. */
export function truncatedMediaRoute(body: Uint8Array, cutAt: number): FakeRoute {
  return {
    match: (url: string) => url.startsWith('https://video.twimg.com/'),
    respond: () => {
      let sent = 0
      // `pull` (not a queue-then-error in `start`, which DISCARDS the queued
      // chunk): real bytes must reach the .part before the connection dies.
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= cutAt) {
            controller.error(new Error('connection reset'))
            return
          }
          const end = Math.min(cutAt, sent + 512)
          controller.enqueue(body.slice(sent, end))
          sent = end
        }
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(body.byteLength) }
      })
    }
  }
}

/** A poster (JPEG-ish bytes) for `pbs.twimg.com`. */
export function posterRoute(bytes: Uint8Array = fakeVideoBytes(64, 3)): FakeRoute {
  return {
    match: (url: string) => url.startsWith('https://pbs.twimg.com/'),
    respond: () =>
      new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.byteLength) }
      })
  }
}
