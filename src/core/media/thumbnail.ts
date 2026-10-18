import path from 'node:path'
import { promises as fs } from 'node:fs'
import { runFfmpeg, type RunFfmpegResult } from '../ffmpeg/runner'

export interface GenerateThumbnailOptions {
  ffmpegPath: string
  source: string
  /** Seek position in seconds (e.g. 10% of duration). */
  atSec: number
  /** Target width in px; height follows the aspect (even-rounded). */
  width: number
  outputPath: string
}

export interface GenerateThumbnailResult {
  outputPath: string
  elapsedMs: number
}

/**
 * Extract a single frame as a JPEG thumbnail (Home project cards).
 * Small, self-contained ffmpeg call: fast-seek to `atSec`, one frame,
 * scale to `width`; best-effort at the call site (import never fails on it).
 */
export async function generateThumbnail(options: GenerateThumbnailOptions): Promise<GenerateThumbnailResult> {
  const startedAt = Date.now()
  const dir = path.dirname(options.outputPath)
  await fs.mkdir(dir, { recursive: true })
  const args = [
    '-ss', Math.max(0, options.atSec).toFixed(3),
    '-i', options.source,
    '-an',
    '-frames:v', '1',
    '-vf', `scale=${options.width}:-2`,
    '-q:v', '3',
    '-y',
    options.outputPath
  ]
  const run: RunFfmpegResult = await runFfmpeg({
    ffmpegPath: options.ffmpegPath,
    args,
    durationSec: 0
  })
  if (run.code !== 0 && !run.cancelled) {
    const tail = run.stderrTail.slice(-10).join('\n')
    throw new Error(`Thumbnail extraction failed (ffmpeg exit ${run.code}): ${tail}`)
  }
  const stat = await fs.stat(options.outputPath)
  if (stat.size === 0) throw new Error('Thumbnail extraction produced an empty file')
  return { outputPath: options.outputPath, elapsedMs: Date.now() - startedAt }
}
