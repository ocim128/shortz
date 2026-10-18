import { spawn } from 'node:child_process'

export interface FfmpegBinaries {
  ffmpegPath: string
  ffprobePath: string
  /** Where the binaries came from — useful for startup logging / settings. */
  source: 'system' | 'bundled' | 'custom'
  version: string | null
}

export type FfmpegSourcePreference = 'auto' | 'system' | 'bundled'

export interface ResolveBinariesOptions {
  preference?: FfmpegSourcePreference
  ffmpegPath?: string
  ffprobePath?: string
}

function runVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    try {
      const child = spawn(binary, ['-version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      })
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
      })
      child.on('error', () => finish(null))
      child.on('close', (code) => {
        if (code !== 0) return finish(null)
        const firstLine = out.split(/\r?\n/)[0] ?? ''
        const match = firstLine.match(/version\s+(\S+)/i)
        finish(match?.[1] ?? firstLine.trim() ?? 'unknown')
      })
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          // ignore
        }
        finish(null)
      }, 10_000).unref()
    } catch {
      finish(null)
    }
  })
}

async function tryBundled(): Promise<{ ffmpegPath: string; ffprobePath: string } | null> {
  try {
    const ffmpegModule = await import('ffmpeg-static')
    const ffprobeModule = await import('ffprobe-static')
    const ffmpegPath = typeof ffmpegModule.default === 'string' ? ffmpegModule.default : null
    const ffprobePath =
      typeof ffprobeModule.default?.path === 'string' ? ffprobeModule.default.path : null
    if (ffmpegPath && ffprobePath) return { ffmpegPath, ffprobePath }
    return null
  } catch {
    return null
  }
}

let cachedAuto: FfmpegBinaries | null = null

/**
 * Resolution order (per docs): system PATH first (full builds ship more filters),
 * bundled ffmpeg-static/ffprobe-static as fallback. Explicit paths win over both.
 */
export async function resolveFfmpegBinaries(
  options: ResolveBinariesOptions = {}
): Promise<FfmpegBinaries> {
  const { preference = 'auto' } = options

  if (options.ffmpegPath && options.ffprobePath) {
    const version = await runVersion(options.ffmpegPath)
    if (version === null) {
      throw new Error(`ffmpeg at "${options.ffmpegPath}" is not executable`)
    }
    return {
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      source: 'custom',
      version
    }
  }

  if (preference === 'system' || preference === 'auto') {
    const [ffmpegVersion, ffprobeVersion] = await Promise.all([
      runVersion('ffmpeg'),
      runVersion('ffprobe')
    ])
    if (ffmpegVersion && ffprobeVersion) {
      return {
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        source: 'system',
        version: ffmpegVersion
      }
    }
    if (preference === 'system') {
      throw new Error('ffmpeg/ffprobe not found on PATH (settings: ffmpeg.source = "system")')
    }
  }

  const bundled = await tryBundled()
  if (bundled) {
    const version = await runVersion(bundled.ffmpegPath)
    if (version) {
      return { ...bundled, source: 'bundled', version }
    }
  }

  throw new Error(
    'No usable FFmpeg found: not on PATH and ffmpeg-static/ffprobe-static are unavailable. ' +
      'Install FFmpeg or add the bundled binary packages.'
  )
}

/** Cached resolver for the 'auto' preference (startup cost paid once). */
export async function resolveFfmpegBinariesCached(
  options: ResolveBinariesOptions = {}
): Promise<FfmpegBinaries> {
  const { preference = 'auto' } = options
  if (preference === 'auto' && !options.ffmpegPath && !options.ffprobePath) {
    if (!cachedAuto) cachedAuto = await resolveFfmpegBinaries(options)
    return cachedAuto
  }
  return resolveFfmpegBinaries(options)
}
