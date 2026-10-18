import { backgroundColorHex, type ResolvedLayout } from '../../shared/layout/engine'
import type { BackgroundStyle } from '../../shared/template/types'

export type EncoderKind = 'libx264' | 'h264_nvenc'

export type AudioMode = 'keep' | 'mute'

export interface TrimSpec {
  start: number
  end: number
}

export interface BuildArgsInput {
  source: string
  layout: ResolvedLayout
  overlayPath: string
  /** Present only for blur background + rounding (Case B2: mask + alphamerge). */
  maskPath?: string
  outputPath: string
  /** Post-trim duration in seconds; drives color=d= and progress math. */
  durationSec: number
  fps: number
  encoder: EncoderKind
  crf?: number
  audio: AudioMode
  hasAudio: boolean
  trim?: TrimSpec
  loglevel?: string
}

export const DEFAULT_CRF = 18
export const DEFAULT_FPS = 30
export const DEFAULT_BLUR_SIGMA = 30
export const DEFAULT_BLUR_DARKEN = 0.05

export function formatSeconds(value: number): string {
  const clamped = Math.max(0, value)
  const rounded = Math.round(clamped * 1000) / 1000
  return String(rounded)
}

/** FFmpeg `color=` literal for solid backgrounds. */
export function ffmpegBackgroundColor(style: BackgroundStyle): string {
  const hex = backgroundColorHex(style)
  if (hex === null) return 'black'
  if (hex === '#000000') return 'black'
  if (hex === '#FFFFFF') return 'white'
  return `0x${hex.slice(1)}`
}

export function buildFilterComplex(input: BuildArgsInput): string {
  const { layout, maskPath } = input
  const { canvas, video } = layout
  const fps = input.fps
  const duration = formatSeconds(input.durationSec)
  const parts: string[] = []

  if (canvas.background === 'blurVideo') {
    // Case B2 / C — blurred scaled copy of the clip behind the letterbox.
    const blur = canvas.blur ?? { sigma: DEFAULT_BLUR_SIGMA, darken: DEFAULT_BLUR_DARKEN }
    parts.push(`[0:v]fps=${fps},split=2[src][sbg]`)
    parts.push(
      `[sbg]scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,` +
        `crop=${canvas.width}:${canvas.height},gblur=sigma=${blur.sigma},` +
        `eq=brightness=${blur.darken > 0 ? `-${formatSeconds(blur.darken)}` : '0'}[bg]`
    )
    parts.push(`[src]scale=${video.w}:${video.h}:flags=lanczos,setsar=1[vid]`)
    let overlaySource = 'vid'
    if (maskPath) {
      parts.push(`[2:v]format=gray[mask]`)
      parts.push(`[vid][mask]alphamerge[vidrounded]`)
      overlaySource = 'vidrounded'
    }
    parts.push(`[bg][${overlaySource}]overlay=${video.x}:${video.y}:shortest=1[base]`)
  } else {
    // Case A — solid background; rounded corners are drawn as corner covers on the overlay PNG.
    const color = ffmpegBackgroundColor(canvas.background)
    parts.push(`[0:v]fps=${fps},scale=${video.w}:${video.h}:flags=lanczos,setsar=1[vid]`)
    parts.push(
      `color=c=${color}:s=${canvas.width}x${canvas.height}:r=${fps}:d=${duration}[bg]`
    )
    parts.push(`[bg][vid]overlay=${video.x}:${video.y}:shortest=1[base]`)
  }

  parts.push(`[base][1:v]overlay=0:0:shortest=1,format=yuv420p[outv]`)
  return parts.join(';')
}

export function buildFfmpegArgs(input: BuildArgsInput): string[] {
  const args: string[] = ['-y', '-nostdin', '-hide_banner', '-loglevel', input.loglevel ?? 'error']

  if (input.trim) {
    args.push('-ss', formatSeconds(input.trim.start), '-t', formatSeconds(input.durationSec))
  }
  args.push('-i', input.source)
  args.push('-loop', '1', '-framerate', String(input.fps), '-i', input.overlayPath)
  if (input.maskPath) {
    args.push('-loop', '1', '-framerate', String(input.fps), '-i', input.maskPath)
  }

  args.push('-filter_complex', buildFilterComplex(input))
  args.push('-map', '[outv]')

  if (input.audio === 'keep' && input.hasAudio) {
    args.push('-map', '0:a?')
  } else if (input.audio === 'mute' && input.hasAudio) {
    args.push('-an')
  }

  if (input.encoder === 'h264_nvenc') {
    args.push('-c:v', 'h264_nvenc', '-rc', 'vbr', '-cq', String(input.crf ?? 19), '-preset', 'p5')
  } else {
    args.push('-c:v', 'libx264', '-crf', String(input.crf ?? DEFAULT_CRF), '-preset', 'veryfast')
  }

  if (input.audio === 'keep' && input.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000')
  }

  args.push('-movflags', '+faststart')
  args.push(input.outputPath)
  return args
}
