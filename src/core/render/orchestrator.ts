import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ulid } from 'ulid'
import { resolveLayout, type ResolvedLayout } from '../../shared/layout/engine'
import type { Template } from '../../shared/template/types'
import {
  buildFfmpegArgs,
  type AudioMode,
  type EncoderKind,
  DEFAULT_CRF,
  DEFAULT_FPS
} from '../ffmpeg/argbuilder'
import { probeWithCache, type ClipMeta } from '../ffmpeg/probe'
import { resolveFfmpegBinariesCached } from '../ffmpeg/resolve-bin'
import { runFfmpeg, type RunFfmpegResult } from '../ffmpeg/runner'
import { createFontBufferLoader, registerFonts } from '../render/fonts'
import { needsMask, renderOverlayAssets } from '../render/overlay'
import { moveWithRetry, rmWithRetry, uniqueOutputPath } from '../store/fs-utils'
import type { ProjectDocument } from '../store/projects'

export type RenderStage = 'probe' | 'resolve' | 'overlay' | 'render' | 'finalize' | 'done'

export interface OrchestratorProgress {
  jobId: string
  stage: RenderStage
  /** 0–100 overall progress. */
  pct: number
  outTimeSec?: number
  speed?: string | null
  stalled?: boolean
}

export interface RenderRequest {
  project: ProjectDocument
  template: Template
  outputPath: string
  /** Directory containing `fonts/` and `templates/`. */
  resourcesDir: string
  tmpRoot?: string
  encoder?: EncoderKind
  crf?: number
  fps?: number
  /** Overrides project.audio when present. */
  audio?: AudioMode
  /** Overrides project.trim when present; null forces no trim. */
  trim?: { start: number; end: number } | null
  ffmpegPath?: string
  ffprobePath?: string
  probeCacheDir?: string
  jobId?: string
  onProgress?: (progress: OrchestratorProgress) => void
  signal?: AbortSignal
}

export interface RenderResult {
  jobId: string
  outputPath: string
  width: number
  height: number
  fps: number
  videoCodec: string
  audioCodec: string | null
  audioChannels: number | null
  durationSec: number
  sizeBytes: number
  elapsedMs: number
  layout: ResolvedLayout
  warnings: string[]
}

export class RenderCancelledError extends Error {
  readonly jobId: string

  constructor(jobId: string) {
    super('Render cancelled')
    this.name = 'RenderCancelledError'
    this.jobId = jobId
  }
}

export class RenderError extends Error {
  readonly jobId: string
  readonly stage: RenderStage
  readonly stderrTail: string[]

  constructor(jobId: string, stage: RenderStage, message: string, stderrTail: string[] = []) {
    super(message)
    this.name = 'RenderError'
    this.jobId = jobId
    this.stage = stage
    this.stderrTail = stderrTail
  }
}

export function defaultTmpRoot(): string {
  return path.join(os.tmpdir(), 'shortz')
}

const STAGE_BASE_PCT: Record<RenderStage, number> = {
  probe: 0,
  resolve: 2,
  overlay: 4,
  render: 5,
  finalize: 100,
  done: 100
}

export async function renderProject(request: RenderRequest): Promise<RenderResult> {
  const jobId = request.jobId ?? ulid()
  const tmpDir = path.join(request.tmpRoot ?? defaultTmpRoot(), jobId)
  const startedAt = Date.now()

  const report = (
    stage: RenderStage,
    pct: number,
    extra: Partial<OrchestratorProgress> = {}
  ): void => {
    request.onProgress?.({ jobId, stage, pct, ...extra })
  }

  function fail(stage: RenderStage, error: unknown): never {
    if (error instanceof RenderError || error instanceof RenderCancelledError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new RenderError(jobId, stage, message)
  }

  try {
    await fs.mkdir(tmpDir, { recursive: true })

    // Stage 1 — PROBE
    report('probe', STAGE_BASE_PCT.probe)
    const sourcePath = path.resolve(request.project.source.path)
    let binaries = { ffmpegPath: '', ffprobePath: '' }
    try {
      binaries = await resolveFfmpegBinariesCached({
        ...(request.ffmpegPath ? { ffmpegPath: request.ffmpegPath } : {}),
        ...(request.ffprobePath ? { ffprobePath: request.ffprobePath } : {})
      })
    } catch (error) {
      fail('probe', error)
    }
    let clip: ClipMeta
    try {
      clip = await probeWithCache(sourcePath, {
        ffprobePath: binaries.ffprobePath,
        ...(request.probeCacheDir ? { cacheDir: request.probeCacheDir } : {})
      })
    } catch (error) {
      fail('probe', error)
    }

    const trim = normalizeTrim(
      request.trim !== undefined ? request.trim : (request.project.trim ?? null),
      clip.durationSec
    )
    const durationSec = trim ? trim.end - trim.start : clip.durationSec
    if (durationSec > 600) {
      throw new RenderError(
        jobId,
        'probe',
        `Clip duration ${durationSec.toFixed(1)}s exceeds the 10 minute limit`
      )
    }
    const audio: AudioMode = request.audio ?? request.project.audio ?? 'keep'
    const fps = request.fps ?? DEFAULT_FPS
    const encoder = request.encoder ?? 'libx264'

    // Stage 2 — RESOLVE
    report('resolve', STAGE_BASE_PCT.resolve)
    const fontsDir = path.join(request.resourcesDir, 'fonts')
    const loadFont = createFontBufferLoader(fontsDir)
    let layout: ResolvedLayout
    try {
      layout = resolveLayout({
        template: request.template,
        values: request.project.values,
        clip: { width: clip.width, height: clip.height, durationSec: clip.durationSec },
        loadFont
      })
    } catch (error) {
      fail('resolve', error)
    }

    // Stage 3 — OVERLAY
    report('overlay', STAGE_BASE_PCT.overlay)
    const overlayPath = path.join(tmpDir, 'overlay.png')
    const maskPath = path.join(tmpDir, 'mask.png')
    try {
      registerFonts(fontsDir)
      const assets = renderOverlayAssets(layout)
      await fs.writeFile(overlayPath, assets.overlayPng)
      if (assets.maskPng) await fs.writeFile(maskPath, assets.maskPng)
    } catch (error) {
      fail('overlay', error)
    }

    // Stage 4/5 — BUILD + RUN
    const outputTmp = path.join(tmpDir, 'out.mp4')
    const args = buildFfmpegArgs({
      source: sourcePath,
      layout,
      overlayPath,
      ...(needsMask(layout) ? { maskPath } : {}),
      outputPath: outputTmp,
      durationSec,
      fps,
      encoder,
      crf: request.crf ?? DEFAULT_CRF,
      audio,
      hasAudio: clip.hasAudio,
      ...(trim ? { trim } : {})
    })

    report('render', STAGE_BASE_PCT.render)
    let run: RunFfmpegResult
    try {
      run = await runFfmpeg({
        ffmpegPath: binaries.ffmpegPath,
        args,
        durationSec,
        ...(request.onProgress
          ? {
              onProgress: (progress): void => {
                const pct =
                  STAGE_BASE_PCT.render +
                  (progress.pct / 100) * (STAGE_BASE_PCT.finalize - STAGE_BASE_PCT.render)
                report('render', pct, {
                  outTimeSec: progress.outTimeSec,
                  speed: progress.speed,
                  stalled: progress.stalled
                })
              }
            }
          : {}),
        ...(request.signal ? { signal: request.signal } : {})
      })
    } catch (error) {
      fail('render', error)
    }

    if (run.cancelled) {
      throw new RenderCancelledError(jobId)
    }
    if (run.stalled) {
      // runFfmpeg already killed the tree; the forced exit lands here with an
      // otherwise opaque non-zero code, so name the actual failure mode.
      const tail = run.stderrTail.slice(-30)
      throw new RenderError(
        jobId,
        'render',
        'FFmpeg stopped responding and was terminated — try a shorter trim or the system encoder',
        tail
      )
    }
    if (run.code !== 0) {
      const tail = run.stderrTail.slice(-30)
      throw new RenderError(jobId, 'render', `FFmpeg exited with code ${String(run.code)}`, tail)
    }

    // Stage 6 — FINALIZE
    report('finalize', STAGE_BASE_PCT.finalize)
    await fs.mkdir(path.dirname(request.outputPath), { recursive: true })
    const finalPath = uniqueOutputPath(request.outputPath)
    try {
      await moveWithRetry(outputTmp, finalPath)
    } catch (error) {
      fail('finalize', error)
    }
    const stat = await fs.stat(finalPath)

    report('done', 100)

    return {
      jobId,
      outputPath: finalPath,
      width: layout.canvas.width,
      height: layout.canvas.height,
      fps,
      videoCodec: encoder === 'h264_nvenc' ? 'h264_nvenc' : 'libx264',
      audioCodec: audio === 'keep' && clip.hasAudio ? 'aac' : null,
      audioChannels: audio === 'keep' && clip.hasAudio ? 2 : null,
      durationSec,
      sizeBytes: stat.size,
      elapsedMs: Date.now() - startedAt,
      layout,
      warnings: layout.warnings
    }
  } finally {
    await rmWithRetry(tmpDir)
  }
}

function normalizeTrim(
  trim: { start: number; end: number } | null,
  clipDuration: number
): { start: number; end: number } | null {
  if (!trim) return null
  const start = Math.min(Math.max(0, trim.start), Math.max(0, clipDuration - 0.1))
  const end = Math.min(Math.max(start + 0.1, trim.end), clipDuration)
  if (end - start <= 0) return null
  return { start, end }
}
