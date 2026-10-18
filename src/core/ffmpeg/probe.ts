import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

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
  const bitrate = bitrateRaw !== undefined && Number.isFinite(Number(bitrateRaw)) ? Number(bitrateRaw) : null

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

export async function probeWithCache(source: string, options: ProbeCacheOptions): Promise<ClipMeta> {
  const absolute = path.resolve(source)
  const { cacheDir } = options
  let cacheKey: string | null = null
  let cacheFile: string | null = null

  if (cacheDir) {
    try {
      const stat = await fs.stat(absolute)
      cacheKey = createHash('sha1')
        .update(`${absolute}|${stat.size}|${stat.mtimeMs}`)
        .digest('hex')
      cacheFile = path.join(cacheDir, `${cacheKey}.json`)
      const cached = await fs.readFile(cacheFile, 'utf8')
      const meta = JSON.parse(cached) as ClipMeta
      if (isValidCachedMeta(meta) && meta.path === absolute) return meta
    } catch {
      // cache miss or unreadable cache — fall through to probing
    }
  }

  const meta = await probeSource(options.ffprobePath, absolute)
  if (cacheFile) {
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true })
      await fs.writeFile(cacheFile, JSON.stringify(meta, null, 2), 'utf8')
    } catch {
      // caching is best-effort
    }
  }
  return meta
}

function isValidCachedMeta(meta: ClipMeta): boolean {
  return (
    typeof meta === 'object' &&
    meta !== null &&
    typeof meta.width === 'number' &&
    typeof meta.height === 'number' &&
    typeof meta.durationSec === 'number' &&
    Number.isFinite(meta.durationSec)
  )
}
