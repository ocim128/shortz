import { promises as fs } from 'node:fs'
import path from 'node:path'
import { probeSource } from './probe'
import { runFfmpeg } from './runner'

export type CompressionQuality = 'high' | 'balanced' | 'small'
export interface CompressionResult {
  path: string
  originalBytes: number
  sizeBytes: number
}

/** Compress next to the source without ever replacing an existing file. */
export async function compressVideo(options: {
  source: string
  quality: CompressionQuality
  ffmpegPath: string
  ffprobePath: string
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}): Promise<CompressionResult> {
  const crf = { high: 23, balanced: 28, small: 32 }[options.quality]
  if (crf === undefined) throw new Error('Invalid compression quality')
  const source = path.resolve(options.source)
  const original = await fs.stat(source)
  if (!original.isFile()) throw new Error('Choose a video file')
  const meta = await probeSource(options.ffprobePath, source)
  if (options.signal?.aborted) throw new Error('Compression cancelled')
  const parsed = path.parse(source)
  let output = ''
  for (let i = 0; ; i++) {
    output = path.join(parsed.dir, `${parsed.name}_compressed${i ? `_${i}` : ''}.mp4`)
    try {
      const file = await fs.open(output, 'wx')
      await file.close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  try {
    const result = await runFfmpeg({
      ffmpegPath: options.ffmpegPath,
      args: [
        '-y',
        '-i',
        source,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        String(crf),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        output
      ],
      durationSec: meta.durationSec,
      signal: options.signal,
      onProgress: (progress) => options.onProgress?.(progress.pct)
    })
    if (result.cancelled || options.signal?.aborted) throw new Error('Compression cancelled')
    if (result.stalled) throw new Error('Compression stalled')
    if (result.code !== 0)
      throw new Error(`Compression failed: ${result.stderrTail.slice(-4).join(' ')}`)
    return { path: output, originalBytes: original.size, sizeBytes: (await fs.stat(output)).size }
  } catch (error) {
    await fs.unlink(output).catch(() => undefined)
    throw error
  }
}
