import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { atomicWriteFile } from '../store/fs-utils'

/**
 * Probe result with rotation-normalized display dimensions: a portrait phone
 * recording coded 1920x1080 + rotate metadata reports 1080x1920 here, so the
 * Layout Engine sees the same orientation FFmpeg filters will decode.
 */
export interface ClipMeta {
  path: string
  codedWidth: number
  codedHeight: number
  /** Display dimensions after applying rotation metadata. */
  width: number
  height: number
  /** 0 | 90 | 180 | 270 */
  rotation: number
  durationSec: number
  fps: number
  fpsRational: string
  videoCodec: string
  hasAudio: boolean
  audioCodec: string | null
  audioChannels: number | null
  audioChannelLayout: string | null
  bitrate: number | null
}

export class ProbeError extends Error {
  readonly stderrTail: string[]

  constructor(message: string, stderrTail: string[] = []) {
    super(message)
    this.name = 'ProbeError'
    this.stderrTail = stderrTail
  }
}

interface StreamInfo {
  index?: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  channels?: number
  channel_layout?: string
  duration?: string
  side_data_list?: { rotation?: number; side_data_type?: string }[]
  tags?: Record<string, string>
}

interface FormatInfo {
  duration?: string
  bit_rate?: string
}

interface FfprobeOutput {
  streams?: StreamInfo[]
  format?: FormatInfo
}

export function runFfprobeJson(ffprobePath: string, source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', source]
    const child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      reject(new ProbeError(`Failed to start ffprobe: ${error.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else {
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-10)
        reject(new ProbeError(`ffprobe exited with code ${code}`, tail))
      }
    })
  })
}

export function parseFpsRational(rational: string | undefined): number {
  if (!rational) return 0
  const [numRaw, denRaw] = rational.split('/')
  const num = Number(numRaw)
  const den = denRaw === undefined ? 1 : Number(denRaw)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0
  return num / den
}

export function normalizeRotation(raw: number | string | undefined): number {
  if (raw === undefined) return 0
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (!Number.isFinite(value)) return 0
  const mod = ((Math.round(value) % 360) + 360) % 360
  return mod === 90 || mod === 180 || mod === 270 ? mod : 0
}

export function parseFfprobeJson(rawJson: string, source: string): ClipMeta {
  let parsed: FfprobeOutput
  try {
    parsed = JSON.parse(rawJson) as FfprobeOutput
  } catch (error) {
    throw new ProbeError(`ffprobe returned invalid JSON: ${(error as Error).message}`)
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const video = streams.find((s) => s.codec_type === 'video')
  if (!video || typeof video.width !== 'number' || typeof video.height !== 'number') {
    throw new ProbeError(`No video stream found in "${source}"`)
  }
  const audio = streams.find((s) => s.codec_type === 'audio')

  let rotation = 0
  const sideData = video.side_data_list?.find((sd) => sd.rotation !== undefined)
  if (sideData?.rotation !== undefined) {
    rotation = normalizeRotation(sideData.rotation)
  } else if (video.tags?.rotate !== undefined) {
    rotation = normalizeRotation(video.tags.rotate)
  }

  const swap = rotation === 90 || rotation === 270
  const codedWidth = video.width
  const codedHeight = video.height

  const durationRaw = parsed.format?.duration ?? video.duration
  const durationSec = durationRaw !== undefined ? Number(durationRaw) : NaN
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new ProbeError(`Could not determine duration of "${source}"`)
  }

  const fpsRational = video.r_frame_rate ?? ''
  const fps = parseFpsRational(fpsRational)
  const bitrateRaw = parsed.format?.bit_rate
  const bitrate =
    bitrateRaw !== undefined && Number.isFinite(Number(bitrateRaw)) ? Number(bitrateRaw) : null

  return {
    path: path.resolve(source),
    codedWidth,
    codedHeight,
    width: swap ? codedHeight : codedWidth,
    height: swap ? codedWidth : codedHeight,
    rotation,
    durationSec,
    fps: fps > 0 ? fps : 30,
    fpsRational,
    videoCodec: video.codec_name ?? 'unknown',
    hasAudio: audio !== undefined,
    audioCodec: audio?.codec_name ?? null,
    audioChannels: typeof audio?.channels === 'number' ? audio.channels : null,
    audioChannelLayout: audio?.channel_layout ?? null,
    bitrate
  }
}

export async function probeSource(ffprobePath: string, source: string): Promise<ClipMeta> {
  const json = await runFfprobeJson(ffprobePath, source)
  return parseFfprobeJson(json, source)
}

export interface ProbeCacheOptions {
  ffprobePath: string
  cacheDir?: string
}

/**
 * On-disk envelope. `v` makes invalidation explicit: bump it whenever ClipMeta
 * gains a field, and old entries fall through to a fresh probe instead of
 * silently serving stale shapes.
 */
interface ProbeCacheEnvelope {
  v: number
  meta: ClipMeta
}

const PROBE_CACHE_VERSION = 1
const PROBE_CACHE_MAX_ENTRIES = 2000
const PROBE_CACHE_MAX_BYTES = 50 * 1024 * 1024
const PROBE_CACHE_MAX_AGE_MS = 30 * 24 * 3600_000

export async function probeWithCache(
  source: string,
  options: ProbeCacheOptions
): Promise<ClipMeta> {
  const absolute = path.resolve(source)
  const { cacheDir } = options
  let cacheKey: string | null = null
  let cacheFile: string | null = null

  if (cacheDir) {
    try {
      const stat = await fs.stat(absolute)
      cacheKey = createHash('sha1').update(`${absolute}|${stat.size}|${stat.mtimeMs}`).digest('hex')
      cacheFile = path.join(cacheDir, `${cacheKey}.json`)
      const cached = await fs.readFile(cacheFile, 'utf8')
      const envelope = JSON.parse(cached) as Partial<ProbeCacheEnvelope> | null
      const meta = envelope?.meta
      if (
        envelope?.v === PROBE_CACHE_VERSION &&
        isValidCachedMeta(meta) &&
        meta.path === absolute
      ) {
        return meta
      }
    } catch {
      // cache miss or unreadable cache — fall through to probing
    }
  }

  const meta = await probeSource(options.ffprobePath, absolute)
  if (cacheFile && cacheDir) {
    try {
      const envelope: ProbeCacheEnvelope = { v: PROBE_CACHE_VERSION, meta }
      await atomicWriteFile(cacheFile, JSON.stringify(envelope, null, 2))
    } catch {
      // caching is best-effort
    }
    // Bounded growth, once per process per dir — never on the probe path.
    sweepProbeCache(cacheDir).catch(() => undefined)
  }
  return meta
}

const sweptCacheDirs = new Set<string>()

/**
 * Opportunistic cache eviction, once per process per dir: drop entries older
 * than the age floor, then trim oldest-first until the entry/byte caps hold.
 */
async function sweepProbeCache(cacheDir: string): Promise<void> {
  if (sweptCacheDirs.has(cacheDir)) return
  let names: string[]
  try {
    names = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.json'))
  } catch {
    return
  }
  sweptCacheDirs.add(cacheDir)
  try {
    const now = Date.now()
    const entries: Array<{ name: string; mtimeMs: number; size: number }> = []
    for (const name of names) {
      const stat = await fs.stat(path.join(cacheDir, name)).catch(() => null)
      if (stat?.isFile()) entries.push({ name, mtimeMs: stat.mtimeMs, size: stat.size })
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let remaining = entries.length
    let totalBytes = entries.reduce((sum, e) => sum + e.size, 0)
    for (const entry of entries) {
      const overAge = now - entry.mtimeMs > PROBE_CACHE_MAX_AGE_MS
      const overCaps = remaining > PROBE_CACHE_MAX_ENTRIES || totalBytes > PROBE_CACHE_MAX_BYTES
      if (!overAge && !overCaps) continue
      await fs.rm(path.join(cacheDir, entry.name), { force: true }).catch(() => undefined)
      remaining -= 1
      totalBytes -= entry.size
    }
  } catch {
    // best effort — the next process retries
  }
}

function isValidCachedMeta(meta: unknown): meta is ClipMeta {
  if (typeof meta !== 'object' || meta === null) return false
  const m = meta as Partial<ClipMeta>
  return (
    typeof m.width === 'number' &&
    typeof m.height === 'number' &&
    typeof m.durationSec === 'number' &&
    Number.isFinite(m.durationSec)
  )
}
