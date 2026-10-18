import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'

/**
 * media:// privileged scheme — docs/technical/project-structure.md §"Local media
 * for preview" + docs/02-architecture.md §Preview Compositor.
 *
 * Chromium will not load file:// media from the app origin, and HTML5 scrubbing
 * needs HTTP Range (206) responses — a naive handler makes every seek restart
 * from byte 0. This handler streams from disk and answers Range requests with
 * 206 + Content-Range (full 200 when no header), so <video> seeks are instant.
 *
 * URLs are minted ONLY by the main process (mintMediaUrl, called from the
 * getMediaUrl IPC handler after validating the path); the renderer never
 * constructs them.
 */

const SCHEME = 'media'

/** Extensions getMediaUrl will mint a media:// URL for. */
const MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpg', '.mpeg', '.ts'])

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t'
}

/** Must run before app ready (docs snippet, verbatim privileges). */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

/** Must run after app ready. */
export function registerMediaProtocol(): void {
  protocol.handle(SCHEME, (request) => handleMediaRequest(request.url, request.headers.get('range')))
}

/**
 * media://<percent-encoded absolute path>. Forward slashes on Windows (fs
 * accepts them and keeps the URL a clean pathname).
 * Form: `media://local/C%3A%2FUsers%2F...` — the scheme is registered
 * `standard`, and standard URLs REJECT an empty host (`media:///…` fails
 * URL parsing), so we mint with the fixed host "local". The handler reads
 * only the pathname. (Recorded in tmp/NOTES-B.md.)
 */
export function mintMediaUrl(absPath: string): string {
  const fwd = process.platform === 'win32' ? absPath.replace(/\\/g, '/') : absPath
  return `${SCHEME}://local/${encodeURIComponent(fwd)}`
}

/** Validate + mint. Throws with a user-readable message when not a media file. */
export async function getMediaUrlForFile(sourcePath: string): Promise<string> {
  const abs = path.resolve(sourcePath)
  if (!path.isAbsolute(abs)) throw new Error(`Not an absolute path: ${sourcePath}`)
  const ext = path.extname(abs).toLowerCase()
  if (!MEDIA_EXTENSIONS.has(ext)) throw new Error(`Unsupported media type "${ext || '(none)'}": ${abs}`)
  const stat = await fsp.stat(abs).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error(`File not found: ${abs}`)
  return mintMediaUrl(abs)
}

function mediaUrlToPath(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== `${SCHEME}:`) return null
    // Primary form: pathname carries the encoded absolute path with a leading '/'.
    let candidate = decodeURIComponent(u.pathname).replace(/^\/+/, '')
    // Tolerate host-form URLs (media://C%3A%2F...) in case a URL was normalized.
    if (!candidate && u.host) candidate = decodeURIComponent(u.host)
    if (!candidate) return null
    if (!path.isAbsolute(candidate)) return null
    return path.normalize(candidate)
  } catch {
    return null
  }
}

interface ByteRange {
  start: number
  end: number // inclusive
}

/**
 * Parse a single-range `bytes=` header against a known size.
 * undefined = no header (full 200); null = unsatisfiable (416).
 */
function parseRange(header: string | null, size: number): ByteRange | null | undefined {
  if (!header) return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  const [, startRaw, endRaw] = m
  let start: number
  let end: number
  if (startRaw === '') {
    // suffix range: last N bytes
    const n = Number(endRaw)
    if (n === 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end }
}

export async function handleMediaRequest(url: string, rangeHeader: string | null): Promise<Response> {
  const filePath = mediaUrlToPath(url)
  if (!filePath) return new Response('Bad media:// URL', { status: 400 })

  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat || !stat.isFile()) return new Response('Not found', { status: 404 })
  const size = stat.size
  if (size === 0) return new Response('Empty file', { status: 404 })

  const parsed = parseRange(rangeHeader, size)
  if (parsed === null) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
  }
  const { start, end } = parsed ?? { start: 0, end: size - 1 }

  const nodeStream = fs.createReadStream(filePath, { start, end })
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  const headers: Record<string, string> = {
    'content-type': MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-length': String(end - start + 1),
    'cache-control': 'no-store',
    // The scheme is registered without `corsEnabled`, so cross-origin fetch()
    // (e.g. from the dev/verification harness) needs an explicit ACAO.
    // <video> playback never needed it.
    'access-control-allow-origin': '*'
  }
  if (rangeHeader) {
    headers['content-range'] = `bytes ${start}-${end}/${size}`
    return new Response(body, { status: 206, headers })
  }
  return new Response(body, { status: 200, headers })
}
