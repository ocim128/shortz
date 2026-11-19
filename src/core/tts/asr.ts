import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { killProcessTree } from '../ffmpeg/runner'
import { defaultVoxPythonPath } from './voxcpm'

/**
 * ASR verification worker client — same JSON-lines protocol and lifecycle as
 * the VoxCPM worker in voxcpm.ts (kept loaded, single pending request,
 * killed on abort/idle). The worker itself is resources/tts/asr_worker.py.
 */

export interface AsrWord {
  word: string
  start: number
  end: number
}

export interface AsrResult {
  transcript: string
  words: AsrWord[]
  durationSec: number
}

export function defaultAsrPythonPath(): string {
  if (process.env.SHORTZ_ASR_PYTHON) return process.env.SHORTZ_ASR_PYTHON
  // The verifier rides the same runtime as the model (faster-whisper is part
  // of the documented speech setup); SHORTZ_VOXCPM_PYTHON still applies.
  return defaultVoxPythonPath()
}

type Pending = {
  id: number
  resolve: (result: AsrResult) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort: () => void
}

let nextId = 0

class AsrWorker {
  private readonly child: ChildProcessWithoutNullStreams
  private pending: Pending | undefined
  private stderr = ''
  private startError: Error | undefined
  private closed = false

  constructor(readonly python: string, readonly script: string) {
    this.child = spawn(python, [script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '0' }
    })
    this.child.stderr.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000)
    })
    this.child.stdin.on('error', () => {
      /* close reports the failure */
    })
    this.child.on('error', (error) => {
      this.startError = error
    })
    this.child.on('close', () => {
      this.closed = true
      if (worker === this) worker = undefined
      const pending = this.pending
      if (!pending) return
      this.pending = undefined
      pending.signal?.removeEventListener('abort', pending.abort)
      pending.reject(
        new Error(
          this.startError
            ? `Speech verifier could not start: ${this.startError.message}`
            : `Speech verifier exited early: ${this.stderr.trim().slice(-600) || 'no output'}`
        )
      )
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line))
    // No idle timer: model load costs seconds, and the CLI runs bursts of
    // chunks; the caller stops the worker explicitly when the episode ends.
  }

  private handleLine(line: string): void {
    let response: { id?: number; ok?: boolean; error?: string } & Partial<AsrResult>
    try {
      response = JSON.parse(line) as typeof response
    } catch {
      return
    }
    if (!this.pending || response.id !== this.pending.id) return
    if (this.pending.signal?.aborted) return this.finish(new Error('Speech verification cancelled'))
    if (response.ok !== true) {
      const detail = response.error ?? 'unknown error'
      const message = /No module named ['"]faster_whisper['"]|missing the verifier/.test(detail)
        ? 'The speech runtime is missing the verifier. Install it with: "<ShortZ voxcpm python>" -m pip install faster-whisper'
        : /could not start/.test(detail)
          ? `Speech verifier could not start. ${detail.slice(-600)}`
          : `Speech verification failed: ${detail.slice(-1200)}`
      return this.finish(new Error(message))
    }
    this.finish(undefined, {
      transcript: response.transcript ?? '',
      words: response.words ?? [],
      durationSec: response.durationSec ?? 0
    })
  }

  private finish(error?: Error, result?: AsrResult): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    pending.signal?.removeEventListener('abort', pending.abort)
    if (error) pending.reject(error)
    else pending.resolve(result!)
  }

  transcribe(wavPath: string, signal?: AbortSignal): Promise<AsrResult> {
    if (signal?.aborted) return Promise.reject(new Error('Speech verification cancelled'))
    if (this.closed) {
      throw new Error(
        this.startError
          ? `Speech verifier could not start. ${this.startError.message}`
          : `Speech verifier exited: ${this.stderr.trim().slice(-600)}`
      )
    }
    if (this.pending) return Promise.reject(new Error('A speech verification is already running'))
    return new Promise<AsrResult>((resolve, reject) => {
      const id = ++nextId
      const abort = (): void => this.stop()
      this.pending = { id, resolve, reject, signal, abort }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) return abort()
      this.child.stdin.write(`${JSON.stringify({ id, wav: path.resolve(wavPath) })}\n`, 'utf8')
    })
  }

  stop(): void {
    if (this.child.pid) void killProcessTree(this.child.pid)
    else this.child.kill()
  }
}

let worker: AsrWorker | undefined

export function stopAsrWorker(): void {
  worker?.stop()
  worker = undefined
}

/** Transcribe one WAV chunk, keeping the verifier loaded between calls. */
export async function transcribeChunk(
  wavPath: string,
  options: { pythonPath?: string; workerPath: string; signal?: AbortSignal }
): Promise<AsrResult> {
  const python = options.pythonPath ?? defaultAsrPythonPath()
  if (worker && (worker.python !== python || worker.script !== options.workerPath)) {
    throw new Error('A different speech verifier is already running')
  }
  worker ??= new AsrWorker(python, options.workerPath)
  return worker.transcribe(wavPath, options.signal)
}
