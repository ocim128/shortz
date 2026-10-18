import { spawn, type ChildProcess } from 'node:child_process'

export interface RunnerProgress {
  outTimeSec: number
  pct: number
  fps: number | null
  speed: string | null
  stalled: boolean
}

export interface RunFfmpegOptions {
  ffmpegPath: string
  args: string[]
  durationSec: number
  onProgress?: (progress: RunnerProgress) => void
  onStderrLine?: (line: string) => void
  signal?: AbortSignal
  /** No progress output for this long (and no exit) => stalled. Default 60s. */
  stallTimeoutMs?: number
  /** Max stderr lines kept for error reporting tail. */
  stderrTailLines?: number
}

export interface RunFfmpegResult {
  code: number | null
  cancelled: boolean
  stalled: boolean
  stderrTail: string[]
  elapsedMs: number
}

interface KillResult {
  code: number | null
  stderr: string
}

/**
 * Kill a process tree on Windows. `taskkill` exit code 128 ("process not found")
 * is treated as success: the render may exit naturally just before the kill lands.
 */
export function killProcessTree(pid: number): Promise<KillResult> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
      resolve({ code: 0, stderr: '' })
      return
    }
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', () => resolve({ code: 0, stderr }))
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

const PROGRESS_THROTTLE_MS = 250
const STALL_CHECK_MS = 10_000

/**
 * Spawn FFmpeg, parse `-progress pipe:1`, report throttled progress,
 * support cancellation and stalled detection. Never uses a shell.
 */
export async function runFfmpeg(options: RunFfmpegOptions): Promise<RunFfmpegResult> {
  const {
    ffmpegPath,
    durationSec,
    onProgress,
    onStderrLine,
    signal,
    stallTimeoutMs = 60_000,
    stderrTailLines = 60
  } = options

  const args = [...options.args, '-progress', 'pipe:1', '-nostats']
  const startedAt = Date.now()

  return await new Promise<RunFfmpegResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdoutBuffer = ''
    let stderrBuffer = ''
    const stderrTail: string[] = []
    let cancelled = false
    let stalled = false
    let settled = false
    let lastProgressAt = Date.now()
    let lastEmitAt = 0
    let lastOutTimeSec = 0
    let lastFps: number | null = null
    let lastSpeed: string | null = null

    const emit = (force: boolean): void => {
      if (!onProgress) return
      const now = Date.now()
      if (!force && now - lastEmitAt < PROGRESS_THROTTLE_MS) return
      lastEmitAt = now
      const pct = durationSec > 0 ? Math.min(100, (lastOutTimeSec / durationSec) * 100) : 0
      onProgress({
        outTimeSec: lastOutTimeSec,
        pct,
        fps: lastFps,
        speed: lastSpeed,
        stalled
      })
    }

    const handleProgressLine = (line: string): void => {
      const eq = line.indexOf('=')
      if (eq < 0) return
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      lastProgressAt = Date.now()
      switch (key) {
        case 'out_time_us':
        case 'out_time_ms': {
          // Note: FFmpeg's out_time_ms is microseconds despite the name.
          const micros = Number(value)
          if (Number.isFinite(micros)) {
            lastOutTimeSec = Math.max(lastOutTimeSec, micros / 1_000_000)
          }
          break
        }
        case 'out_time': {
          const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/)
          if (match) {
            const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
            lastOutTimeSec = Math.max(lastOutTimeSec, seconds)
          }
          break
        }
        case 'fps': {
          const fps = Number(value)
          if (Number.isFinite(fps)) lastFps = fps
          break
        }
        case 'speed':
          lastSpeed = value
          break
        case 'progress':
          emit(value === 'end')
          break
        default:
          break
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) handleProgressLine(line)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8')
      const lines = stderrBuffer.split(/\r?\n/)
      stderrBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length === 0) continue
        stderrTail.push(line)
        if (stderrTail.length > stderrTailLines) stderrTail.shift()
        onStderrLine?.(line)
      }
    })

    const stallTimer = setInterval(
      () => {
        if (settled) return
        if (stalled) return
        if (Date.now() - lastProgressAt > stallTimeoutMs) {
          stalled = true
          emit(true)
          // A wedged ffmpeg would hold the export slot forever — kill the tree
          // so the run settles as a stalled failure (the orchestrator maps that
          // to an actionable RenderError) instead of hanging. Distinct from a
          // user cancel: `cancelled` stays false.
          const pid = child.pid
          if (child.exitCode !== null || pid === undefined) return
          void killProcessTree(pid).catch(() => undefined)
        }
      },
      // Check at the stall horizon, never slower than the default cadence.
      Math.min(STALL_CHECK_MS, Math.max(250, stallTimeoutMs))
    )
    stallTimer.unref?.()

    const onAbort = (): void => {
      if (settled || cancelled) return
      cancelled = true
      const pid = child.pid
      if (child.exitCode !== null || pid === undefined) {
        // Already finished — nothing to kill.
        return
      }
      void killProcessTree(pid).catch(() => undefined)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = async (code: number | null): Promise<void> => {
      if (settled) return
      settled = true
      clearInterval(stallTimer)
      signal?.removeEventListener('abort', onAbort)
      emit(true)
      resolve({
        code,
        cancelled,
        stalled,
        stderrTail,
        elapsedMs: Date.now() - startedAt
      })
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearInterval(stallTimer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })

    child.on('close', (code) => {
      void finish(code)
    })
  })
}
