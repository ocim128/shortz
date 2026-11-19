import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { findVoicePreset, TTS_MAX_TEXT_LENGTH } from '../../shared/tts/voices'
import { stripDeliveryTags } from './chunks'
import { atomicWriteFile } from '../store/fs-utils'
import { killProcessTree, runFfmpeg } from '../ffmpeg/runner'

export interface VoxSynthesisInput {
  text: string
  voiceId: string
  outputPath: string
  ffmpegPath: string
  workerPath: string
  signal?: AbortSignal
  pythonPath?: string
  referenceCacheDir?: string
}

export function defaultVoxPythonPath(): string {
  if (process.env.SHORTZ_VOXCPM_PYTHON) return process.env.SHORTZ_VOXCPM_PYTHON
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ShortZ', 'voxcpm', 'Scripts', 'python.exe')
  }
  return path.join(os.homedir(), '.local', 'share', 'shortz', 'voxcpm', 'bin', 'python')
}

const IDLE_TIMEOUT_MS = 2 * 60 * 1000
let worker: VoxWorker | undefined
let nextId = 0

type Pending = {
  id: number
  resolve: () => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort: () => void
}

class VoxWorker {
  private readonly child: ChildProcessWithoutNullStreams
  private pending: Pending | undefined
  private stderr = ''
  private startError: Error | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(readonly python: string, readonly script: string) {
    this.child = spawn(python, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } })
    this.child.stderr.on('data', (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-6000) })
    this.child.stdin.on('error', () => { /* close reports the failure */ })
    this.child.on('error', (error) => { this.startError = error })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line))
    this.child.on('close', (code) => {
      this.closed = true
      if (this.idleTimer) clearTimeout(this.idleTimer)
      if (worker === this) worker = undefined
      if (!this.pending) return
      let message = `VoxCPM failed: ${this.stderr.trim().slice(-1500) || `exit ${code}`}`
      if (this.startError) message = `VoxCPM could not start. Install the speech runtime (see README). ${this.startError.message}`
      this.finish(this.pending.signal?.aborted ? new Error('Speech generation cancelled') : new Error(message))
    })
  }

  private handleLine(line: string): void {
    let response: { id?: number; ok?: boolean; error?: string }
    try { response = JSON.parse(line) as typeof response } catch { return }
    if (!this.pending || response.id !== this.pending.id) return
    if (this.pending.signal?.aborted) return this.finish(new Error('Speech generation cancelled'))
    if (response.ok !== true) {
      const detail = response.error ?? 'unknown error'
      const message = /ModuleNotFoundError: No module named ['"](?:torch|voxcpm|numpy|soundfile)['"]/.test(detail)
        ? 'The VoxCPM speech runtime is incomplete. Complete the Speech setup in the project README.'
        : `VoxCPM failed: ${detail.slice(-1500)}`
      return this.finish(new Error(message))
    }
    this.finish()
  }

  private finish(error?: Error): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    pending.signal?.removeEventListener('abort', pending.abort)
    if (!this.closed) {
      this.idleTimer = setTimeout(() => this.stop(), IDLE_TIMEOUT_MS)
      this.idleTimer.unref()
    }
    if (error) pending.reject(error)
    else pending.resolve()
  }

  run(request: object, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('Speech generation cancelled'))
    if (this.closed) return Promise.reject(new Error('Speech worker is not running'))
    if (this.pending) return Promise.reject(new Error('A speech generation is already running'))
    if (this.idleTimer) clearTimeout(this.idleTimer)
    return new Promise<void>((resolve, reject) => {
      const id = ++nextId
      const abort = (): void => this.stop()
      this.pending = { id, resolve, reject, signal, abort }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) return abort()
      this.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`, 'utf8')
    })
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (worker === this) worker = undefined
    if (this.child.pid) void killProcessTree(this.child.pid)
    else this.child.kill()
  }
}

export function stopVoxWorker(): void {
  worker?.stop()
}

/** Reference-clip cache key for a (prompt, seed) voice design. */
export function voxReferencePath(prompt: string, seed: number, cacheDir?: string): string {
  const referenceKey = createHash('sha256')
    .update(JSON.stringify(['voxcpm2-reference-v1', prompt, seed]))
    .digest('hex')
  return path.join(
    cacheDir ?? path.join(os.tmpdir(), 'shortz-voxcpm-references'),
    `${referenceKey}.wav`
  )
}

/** One raw synthesis call on the kept-alive worker (pipeline chunk use). */
export async function synthesizeVoxChunk(
  request: { text: string; prompt: string; seed: number; output: string; reference: string; ffmpeg_path?: string },
  options: { pythonPath?: string; workerPath: string; signal?: AbortSignal }
): Promise<void> {
  await runWorker(options.pythonPath ?? defaultVoxPythonPath(), options.workerPath, request, options.signal)
}

async function runWorker(python: string, script: string, request: object, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Speech generation cancelled')
  if (worker && (worker.python !== python || worker.script !== script)) {
    throw new Error('A different speech worker is already running')
  }
  worker ??= new VoxWorker(python, script)
  await worker.run(request, signal)
}

export async function synthesizeVoxSpeech(input: VoxSynthesisInput): Promise<{ path: string; bytes: number }> {
  // The quick path (desktop preview / plain CLI text) never speaks delivery
  // tags — the verified pipeline is where their energy switching happens.
  const text = stripDeliveryTags(input.text).trim()
  if (!text) throw new Error('Enter some text to convert to speech')
  if (text.length > TTS_MAX_TEXT_LENGTH) throw new Error(`Text is too long (${text.length} chars; max ${TTS_MAX_TEXT_LENGTH})`)
  const preset = findVoicePreset(input.voiceId)
  if (!preset) throw new Error(`Unknown voice: ${input.voiceId}`)
  if (input.signal?.aborted) throw new Error('Speech generation cancelled')
  const referenceKey = createHash('sha256').update(JSON.stringify(['voxcpm2-reference-v1', preset.prompt, preset.seed])).digest('hex')
  const reference = path.join(input.referenceCacheDir ?? path.join(os.tmpdir(), 'shortz-voxcpm-references'), `${referenceKey}.wav`)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortz-voxcpm-'))
  try {
    const wav = path.join(dir, 'speech.wav')
    const mp3 = path.join(dir, 'speech.mp3')
    await runWorker(input.pythonPath ?? defaultVoxPythonPath(), input.workerPath,
      // ffmpeg_path lets the worker pre-clean the cached reference once, so
      // the desktop one-shot and the CLI pipeline share the same clean voice.
      { text, prompt: preset.prompt, seed: preset.seed, output: wav, reference, ffmpeg_path: input.ffmpegPath },
      input.signal)
    const audioFile = await fs.stat(wav).catch(() => undefined)
    if (!audioFile?.isFile() || audioFile.size === 0) {
      throw new Error('Speech generation did not produce an audio file. Restart ShortZ and try again.')
    }
    const result = await runFfmpeg({
      ffmpegPath: input.ffmpegPath,
      args: ['-y', '-i', wav, '-c:a', 'libmp3lame', '-q:a', '3', mp3],
      durationSec: Math.max(1, text.length / 14), signal: input.signal
    })
    if (result.cancelled || input.signal?.aborted) throw new Error('Speech generation cancelled')
    if (result.code !== 0) throw new Error(`Speech encoding failed: ${result.stderrTail.slice(-3).join(' ')}`)
    const data = await fs.readFile(mp3)
    if (!data.length) throw new Error('Speech encoding produced an empty file')
    await atomicWriteFile(input.outputPath, data)
    return { path: input.outputPath, bytes: data.length }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
