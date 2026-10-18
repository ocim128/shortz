import fsp from 'node:fs/promises'
import path from 'node:path'
import { ulid } from 'ulid'
import type {
  BatchRenderEvent,
  BatchRenderItem,
  BatchRenderItemStatus,
  BatchRunRequest,
  BatchRunSummary
} from '../preload/api'
import { buildOutputPath } from './output-path'
import { currentSettings, probeCachesDir, resourcesDir, dataDir } from './data'
import { resolveFfmpegBinariesCached, type FfmpegSourcePreference } from '../core/ffmpeg/resolve-bin'
import { probeWithCache } from '../core/ffmpeg/probe'
import { loadTemplateById } from '../core/store/templates'
import { loadEditorConfig } from '../core/store/editor-configs'
import type { KnobId } from '../shared/template/knob-registry'
import { renderProject, type OrchestratorProgress } from '../core/render/orchestrator'
import { hookFieldKeyOf } from '../shared/batch/parse'
import { logWarn } from '../core/log'

/**
 * Batch render queue — one ffmpeg at a time, in the order the lines were typed.
 *
 * Each item is a throwaway render: no project is written to disk (the batch
 * screen is a pipeline, not an editor), the template plus knobs come from the
 * loaded editor config (or settings' defaults), and the hook text lands in the
 * template's hook input. Output names go through the same token builder as the
 * editor's Export, so `{name}` is the clip's own filename.
 *
 * Progress reaches the renderer on 'shortz:batch:progress'. The run is a single
 * flight and cancellable: cancel aborts the running ffmpeg and skips the rest.
 */

interface ActiveRun {
  jobId: string
  controller: AbortController
}

let activeRun: ActiveRun | null = null
let emit: (event: BatchRenderEvent) => void = () => undefined

export function setBatchEmitter(fn: (event: BatchRenderEvent) => void): void {
  emit = fn
}

/** Abort the running batch. Returns false when no run (or a different one) is active. */
export function cancelBatchRun(jobId?: string): boolean {
  const run = activeRun
  if (!run) return false
  if (jobId !== undefined && run.jobId !== jobId) return false
  run.controller.abort()
  return true
}

function event(
  jobId: string,
  item: BatchRenderItem | null,
  index: number,
  total: number,
  status: BatchRenderItemStatus,
  extra: Partial<BatchRenderEvent> = {}
): BatchRenderEvent {
  return { jobId, index, total, status, ...(item ? { item } : {}), ...extra }
}

/**
 * Run every item sequentially. Resolves once the queue settles — partial
 * success is normal, so one item's failure never throws out of here.
 */
export async function runBatch(request: BatchRunRequest): Promise<BatchRunSummary> {
  if (activeRun) throw new Error('A batch render is already running — cancel it first')
  if (request.items.length === 0) throw new Error('The batch is empty — add at least one line')

  const jobId = ulid()
  const controller = new AbortController()
  const run: ActiveRun = { jobId, controller }
  activeRun = run

  const total = request.items.length
  let completed = 0
  let failed = 0
  let cancelled = false

  try {
    const settings = await currentSettings()
    const binaries = await resolveFfmpegBinariesCached({
      preference: settings.ffmpeg.source as FfmpegSourcePreference
    })

    // Template + saved values are resolved ONCE for the whole queue: every line
    // shares the loaded configuration, only path and hook differ.
    let templateId = request.templateId ?? 'hook-letterbox'
    let knobs: Partial<Record<KnobId, unknown>> = {}
    let fields: Record<string, string> = {}
    let audio: 'keep' | 'mute' = request.audio ?? 'keep'
    let trim: { start: number; end: number } | null = null

    if (request.configId) {
      try {
        const saved = await loadEditorConfig(request.configId, dataDir())
        templateId = saved.templateId
        fields = { ...saved.values.fields }
        knobs = saved.values.knobs
        audio = request.audio ?? saved.audio
        if (request.configTrim && saved.trim.end > saved.trim.start) {
          trim = { ...saved.trim }
        }
      } catch (error) {
        // A missing/corrupt config must not silently render with the wrong
        // template — fail the whole run before touching any clip.
        throw new Error(
          `Could not load the saved configuration: ${(error as Error).message}`
        )
      }
    }

    const template = await loadTemplateById(resourcesDir(), templateId)
    const hookKey = hookFieldKeyOf(template.inputs)
    const outputDir = request.outputDir ?? settings.output.dir
    // 'auto' stays on software x264 for determinism; NVENC is the one hardware
    // path the v1 arg-builder supports.
    const preferred = settings.encoder.preferred
    const encoder = preferred === 'h264_nvenc' ? ('h264_nvenc' as const) : ('libx264' as const)
    const crf = request.crf ?? settings.encoder.crf

    emit(event(jobId, null, 0, total, 'starting'))

    for (let i = 0; i < total; i += 1) {
      const item = request.items[i] as BatchRenderItem
      if (controller.signal.aborted) {
        cancelled = true
        emit(event(jobId, item, i, total, 'skipped'))
        continue
      }

      try {
        emit(event(jobId, item, i, total, 'probing', { percent: 0 }))

        const abs = path.resolve(item.path)
        const stat = await fsp.stat(abs).catch(() => null)
        if (!stat || !stat.isFile()) throw new Error(`File not found: ${abs}`)

        // 'source' fps is resolved per item — clips in one batch may differ.
        let fps: number | undefined = request.fps
        if (fps === undefined && settings.encoder.fps === 'source') {
          const clip = await probeWithCache(abs, {
            ffprobePath: binaries.ffprobePath,
            cacheDir: probeCachesDir()
          })
          fps = Math.max(1, Math.round(clip.fps))
        }

        const clipName = path.basename(abs, path.extname(abs))
        const outputTarget = buildOutputPath({
          dir: outputDir,
          pattern: settings.output.filenamePattern,
          name: clipName,
          templateId: template.id,
          seq: i + 1
        })

        // Every declared input gets a value: the hook from the line, the rest
        // from the config. A required input left empty would fail the strict
        // resolve and burn the whole item.
        const itemFields: Record<string, string> = { ...fields, [hookKey]: item.hook }
        for (const input of template.inputs) {
          if (itemFields[input.key] === undefined) itemFields[input.key] = ''
        }

        const now = new Date().toISOString()
        const result = await renderProject({
          project: {
            schemaVersion: 1,
            // Not persisted: the id only has to be unique inside this job.
            id: `${jobId}-${i}`,
            name: clipName,
            createdAt: now,
            updatedAt: now,
            source: { path: abs, probe: null },
            templateId: template.id,
            values: { fields: itemFields, knobs },
            trim: trim ?? { start: 0, end: 0 },
            audio
          },
          template,
          outputPath: outputTarget,
          resourcesDir: resourcesDir(),
          encoder,
          crf,
          audio,
          trim,
          ...(fps !== undefined ? { fps } : {}),
          ffmpegPath: binaries.ffmpegPath,
          ffprobePath: binaries.ffprobePath,
          probeCacheDir: probeCachesDir(),
          signal: controller.signal,
          onProgress: (progress: OrchestratorProgress) => {
            emit(
              event(jobId, item, i, total, 'rendering', {
                percent: Math.max(0, Math.min(100, Math.round(progress.pct))),
                stage: progress.stage
              })
            )
          }
        })

        completed += 1
        emit(
          event(jobId, item, i, total, 'done', {
            percent: 100,
            outputPath: result.outputPath,
            durationSec: Math.round(result.durationSec * 1000) / 1000,
            sizeBytes: result.sizeBytes
          })
        )
      } catch (error) {
        if (controller.signal.aborted) {
          cancelled = true
          emit(event(jobId, item, i, total, 'skipped'))
          continue
        }
        failed += 1
        const message = error instanceof Error ? error.message : String(error)
        logWarn(`[shortz] batch item ${i + 1} failed: ${message}`)
        emit(event(jobId, item, i, total, 'error', { error: message }))
      }
    }
  } finally {
    // Only clear the slot this run owns — a newer run may have replaced it.
    if (activeRun === run) activeRun = null
  }

  emit({ jobId, index: total, total, status: cancelled ? 'cancelled' : 'finished', completed, failed })
  return { jobId, completed, failed, cancelled, total }
}
