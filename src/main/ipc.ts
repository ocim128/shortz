import fsp from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import type {
  BatchRenderEvent,
  BatchRunRequest,
  BatchRunSummary,
  EditorConfig,
  EditorConfigMeta,
  ExportOptions,
  ExportResult,
  FontKey,
  Project,
  ProjectMeta,
  Settings,
  TemplateMeta
} from '../preload/api'
import { buildOutputPath } from './output-path'
import { cancelBatchRun, runBatch, setBatchEmitter } from './batch'
import { getMediaUrlForFile, mintMediaUrl } from './protocol/media'
import {
  currentSettings,
  dataDir,
  fontsDir,
  probeCachesDir,
  projectDir,
  projectFilePath,
  projectsRoot,
  resourcesDir,
  saveCurrentSettings,
  thumbAvailable,
  thumbPath,
  userTemplatesDir
} from './data'
import {
  deleteProjectDir,
  listProjectIds,
  loadProjectSafe,
  newProjectDocument,
  probeSnapshot,
  repairTrim,
  saveProjectDocumentTo,
  sourceMissing,
  toMeta
} from './wire'
import {
  listTemplates as listTemplateFiles,
  loadTemplateById,
  type TemplateMeta as CoreTemplateMeta
} from '../core/store/templates'
import { assertProjectId } from '../core/store/projects'
import { describeTemplateIssues } from '../shared/template/validate'
import { VIDEO_EXTENSIONS } from '../shared/video-extensions'
import { resolveFfmpegBinariesCached } from '../core/ffmpeg/resolve-bin'
import { probeWithCache } from '../core/ffmpeg/probe'
import { generateThumbnail } from '../core/media/thumbnail'
import { renderProject, defaultTmpRoot, RenderCancelledError, RenderError } from '../core/render/orchestrator'
import { emojiFontBytes, FONT_FILES } from '../core/render/fonts'
import { toProgressEvent } from './progress'
import {
  deleteEditorConfig,
  listEditorConfigs,
  loadEditorConfig,
  saveEditorConfig
} from '../core/store/editor-configs'
import { logInfo, logWarn } from '../core/log'

/**
 * Typed IPC handlers — the real product wiring (docs/technical/project-structure.md
 * §"IPC contract"). Shell/media methods stay as B built them; everything
 * engine-shaped now goes through src/core (the render engine + stores).
 */

function sendToRenderer(channel: string, payload: unknown): void {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  const win = wins[0]
  if (win) win.webContents.send(channel, payload)
}

export function sendMenuCommand(cmd: 'new-project' | 'open-settings'): void {
  sendToRenderer('shortz:menu:command', cmd)
}

function handle<A extends unknown[]>(channel: string, fn: (...args: A) => Promise<unknown>): void {
  ipcMain.handle(channel, (_event, ...args: A) => fn(...args))
}

function firstWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  return wins[0] ?? null
}

async function resolveBinariesWithSettings(): Promise<
  Awaited<ReturnType<typeof resolveFfmpegBinariesCached>>
> {
  const settings = await currentSettings()
  return resolveFfmpegBinariesCached({ preference: settings.ffmpeg.source })
}

// One render at a time (the renderer's store models a single job).
let activeAbort: AbortController | null = null
let exportInFlight = false

// --- output filename (docs/technical/export-spec.md §filename convention) ----

function outputPathFor(project: Project, templateId: string, dir: string, pattern: string): string {
  return buildOutputPath({ dir, pattern, name: project.name, templateId })
}

// --- progress mapping --------------------------------------------------------
// (toProgressEvent lives in ./progress.ts — pure and unit-tested.)

function wireTemplateMeta(m: CoreTemplateMeta, badge: 'built-in' | 'user'): TemplateMeta {
  if (m.valid) {
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      badge,
      valid: true,
      body: m.template
    }
  }
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    badge,
    valid: false,
    error: describeTemplateIssues(m.issues)
  }
}

// --- the export job ----------------------------------------------------------

async function runExport(p: Project, opts: ExportOptions): Promise<ExportResult> {
  const settings = await currentSettings()
  const resources = resourcesDir()
  const template = await loadTemplateById(resources, p.templateId)
  const binaries = await resolveBinariesWithSettings()

  const requestedFps = opts.fps ?? settings.encoder.fps
  let fpsOverride: number | undefined
  if (requestedFps === 'source') {
    // The render probes with the same cache dir, so this costs one cache read.
    const clip = await probeWithCache(path.resolve(p.source.path), {
      ffprobePath: binaries.ffprobePath,
      cacheDir: probeCachesDir()
    })
    fpsOverride = Math.max(1, Math.round(clip.fps))
  }

  // 'auto' stays on software x264 for determinism; NVENC is the one hardware
  // path the v1 arg-builder supports.
  const preferred = opts.encoder ?? settings.encoder.preferred
  const encoder = preferred === 'h264_nvenc' ? 'h264_nvenc' : 'libx264'
  const crf = opts.crf ?? settings.encoder.crf

  const outDir = opts.outputDir ?? settings.output.dir
  const outputTarget = outputPathFor(p, template.id, outDir, settings.output.filenamePattern)

  // {0,0} (or unordered) trim = full clip; null forces no trim in the render.
  const trim = p.trim.end > p.trim.start && p.trim.start >= 0 ? p.trim : null
  // Eta math needs the TRIMMED duration: outTimeSec counts the post-trim
  // output timeline, so the full-clip probe snapshot would over-estimate by
  // (clip - trim) for the whole render.
  const durationForEta = trim ? trim.end - trim.start : (p.source.probe?.duration ?? 0)

  const controller = new AbortController()
  activeAbort = controller
  logInfo(
    `[export] start — project=${p.id} template=${template.id} encoder=${encoder} crf=${crf} ` +
      `trim=${trim ? `${trim.start}s-${trim.end}s` : 'full'}`
  )
  try {
    const result = await renderProject({
      project: p,
      template,
      outputPath: outputTarget,
      resourcesDir: resources,
      tmpRoot: defaultTmpRoot(),
      encoder,
      crf,
      trim,
      ...(fpsOverride !== undefined ? { fps: fpsOverride } : {}),
      ffmpegPath: binaries.ffmpegPath,
      ffprobePath: binaries.ffprobePath,
      probeCacheDir: probeCachesDir(),
      signal: controller.signal,
      onProgress: (progress) => {
        sendToRenderer('shortz:render:progress', toProgressEvent(progress, durationForEta))
      }
    })

    sendToRenderer('shortz:render:progress', {
      jobId: result.jobId,
      percent: 100,
      outTimeSec: result.durationSec,
      speed: 0,
      etaSec: 0,
      done: true,
      stage: 'done'
    })

    logInfo(
      `[export] ${result.jobId} done — ${(result.elapsedMs / 1000).toFixed(1)}s, ` +
        `${(result.sizeBytes / 1e6).toFixed(1)} MB, ${result.videoCodec} -> ${result.outputPath}`
    )

    return {
      jobId: result.jobId,
      path: result.outputPath,
      durationSec: Math.round(result.durationSec * 1000) / 1000,
      sizeBytes: result.sizeBytes,
      encoder: result.videoCodec,
      crf
    }
  } catch (error) {
    if (error instanceof RenderCancelledError) {
      logInfo(`[export] ${p.id} cancelled by the user`)
    } else {
      const stage = error instanceof RenderError ? error.stage : '?'
      logWarn(`[export] ${p.id} failed at ${stage}: ${(error as Error).message}`)
    }
    throw error
  } finally {
    activeAbort = null
  }
}

export function registerIpcHandlers(): void {
  // --- projects ---------------------------------------------------------------

  handle('shortz:createProject', async (sourcePath: string): Promise<Project> => {
    const abs = path.resolve(sourcePath)
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat || !stat.isFile()) throw new Error(`File not found: ${abs}`)

    // ffprobe at import (docs: probe snapshot; trim starts disabled — {0,0}).
    const binaries = await resolveBinariesWithSettings()
    const clip = await probeWithCache(abs, {
      ffprobePath: binaries.ffprobePath,
      cacheDir: probeCachesDir()
    })

    const doc = newProjectDocument({
      name: path.basename(abs, path.extname(abs)),
      sourcePath: abs,
      probe: probeSnapshot(clip)
    })
    await saveProjectDocumentTo(projectsRoot(), doc)

    // Home thumbnail: frame at 10% duration, 360px wide → projects/<id>/thumb.jpg.
    // Best-effort: a failed thumbnail never blocks the import itself.
    try {
      await generateThumbnail({
        ffmpegPath: binaries.ffmpegPath,
        source: abs,
        atSec: clip.durationSec * 0.1,
        width: 360,
        outputPath: thumbPath(doc.id)
      })
    } catch (error) {
      logWarn(`[shortz] thumbnail unavailable for ${doc.id}: ${(error as Error).message}`)
    }

    return doc
  })

  handle('shortz:listProjects', async (): Promise<ProjectMeta[]> => {
    const root = projectsRoot()
    const ids = await listProjectIds(root)
    // The per-project round-trips (read+parse project.json, source stat, thumb
    // stat) are independent — fan out instead of serializing ~3N awaits.
    const metas = await Promise.all(
      ids.map(async (id) => {
        const doc = await loadProjectSafe(root, id)
        if (!doc) return null // corrupt project.json was quarantined and logged
        const [missing, hasThumb] = await Promise.all([
          sourceMissing(doc.source.path),
          thumbAvailable(id)
        ])
        return toMeta(doc, missing, hasThumb)
      })
    )
    return metas
      .filter((m): m is ProjectMeta => m !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  })

  handle('shortz:openProject', async (id: string): Promise<Project> => {
    assertProjectId(id)
    const doc = await loadProjectSafe(projectsRoot(), id)
    if (!doc) throw new Error(`No such project: ${id}`)
    const missing = await sourceMissing(doc.source.path)
    return missing ? { ...doc, source: { ...doc.source, missing: true } } : doc
  })

  handle('shortz:saveProject', async (p: Project): Promise<void> => {
    assertProjectId(p.id)
    // Recreate the folder if something (a delete from Explorer) removed it below
    // an in-flight autosave; normal saves silence nothing.
    if (!fss.existsSync(projectFilePath(p.id))) {
      await fsp.mkdir(projectDir(p.id), { recursive: true })
    }
    await saveProjectDocumentTo(projectsRoot(), p)
  })

  handle('shortz:deleteProject', async (id: string): Promise<void> => {
    assertProjectId(id)
    await deleteProjectDir(projectsRoot(), id)
  })

  handle('shortz:relinkSource', async (id: string, newPath: string): Promise<Project> => {
    assertProjectId(id)
    const doc = await loadProjectSafe(projectsRoot(), id)
    if (!doc) throw new Error(`No such project: ${id}`)
    const abs = path.resolve(newPath)
    const st = await fsp.stat(abs).catch(() => null)
    if (!st || !st.isFile()) throw new Error(`File not found: ${abs}`)

    doc.source.path = abs
    try {
      // Re-probe on relink (docs failure table): fresh snapshot + repaired trim.
      const binaries = await resolveBinariesWithSettings()
      const clip = await probeWithCache(abs, {
        ffprobePath: binaries.ffprobePath,
        cacheDir: probeCachesDir()
      })
      doc.source.probe = probeSnapshot(clip)
      repairTrim(doc, clip.durationSec)
    } catch (error) {
      logWarn(`[shortz] relink probe failed for ${id}: ${(error as Error).message}`)
    }
    return saveProjectDocumentTo(projectsRoot(), doc)
  })

  // --- editor configs (named slots — save/list/load/delete, no file dialogs) ---

  handle('shortz:saveEditorConfig', async (c: Omit<EditorConfig, 'savedAt'>): Promise<EditorConfigMeta> => {
    // sanitizeEditorConfig (inside the store) rejects bad shapes with a
    // readable message that the renderer toasts.
    return saveEditorConfig(c, dataDir())
  })

  handle('shortz:listEditorConfigs', async (): Promise<EditorConfigMeta[]> => {
    return listEditorConfigs(dataDir())
  })

  handle('shortz:loadEditorConfig', async (id: string): Promise<EditorConfig> => {
    // The store's configFilePath asserts the ULID shape before joining paths.
    return loadEditorConfig(id, dataDir())
  })

  handle('shortz:deleteEditorConfig', async (id: string): Promise<void> => {
    await deleteEditorConfig(id, dataDir())
  })

  // --- media ------------------------------------------------------------------

  handle('shortz:pickFile', async () => {
    const result = await dialog.showOpenDialog(firstWindow()!, {
      title: 'Choose a video',
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: [...VIDEO_EXTENSIONS] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('shortz:getMediaUrl', async (sourcePath: string) => getMediaUrlForFile(sourcePath))

  handle('shortz:getThumbUrl', async (id: string): Promise<string | null> => {
    assertProjectId(id)
    const file = thumbPath(id)
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat || !stat.isFile()) return null
    // Thumbnails stream through the same media:// handler (image MIME added there).
    return mintMediaUrl(file)
  })

  // --- fonts (strict — fonts ship in resources/fonts, verified baseline) ------

  handle('shortz:getFontBuffer', async (key: FontKey) => {
    // 'emoji' is the platform's system font — best-effort, empty means "none".
    if (key === 'emoji') return emojiFontBytes() ?? new Uint8Array(0)
    const file = FONT_FILES[key]
    if (!file) throw new Error(`Unknown font key: ${key}`)
    const fontPath = path.join(fontsDir(), file)
    try {
      const buf = await fsp.readFile(fontPath)
      return new Uint8Array(buf)
    } catch (error) {
      throw new Error(`Font "${key}" missing at ${fontPath}: ${(error as Error).message}`)
    }
  })

  // --- templates (core registry; TemplateMeta carries the full body) ----------

  handle('shortz:listTemplates', async (): Promise<TemplateMeta[]> => {
    const builtin = await listTemplateFiles(path.join(resourcesDir(), 'templates'))
    const userDir = userTemplatesDir()
    await fsp.mkdir(userDir, { recursive: true }).catch(() => undefined)
    const user = await listTemplateFiles(userDir)
    return [...builtin.map((m) => wireTemplateMeta(m, 'built-in')), ...user.map((m) => wireTemplateMeta(m, 'user'))]
  })

  // --- render -----------------------------------------------------------------

  handle('shortz:exportProject', async (p: Project, opts: ExportOptions = {}): Promise<ExportResult> => {
    if (exportInFlight) throw new Error('An export is already running — cancel it first')
    exportInFlight = true
    try {
      return await runExport(p, opts)
    } finally {
      exportInFlight = false
    }
  })

  handle('shortz:cancelExport', async (): Promise<void> => {
    activeAbort?.abort()
  })

  // --- batch (one line = one clip; nothing is persisted as a project) ---------

  setBatchEmitter((e: BatchRenderEvent) => sendToRenderer('shortz:batch:progress', e))

  handle('shortz:batchRender', async (req: BatchRunRequest): Promise<BatchRunSummary> => {
    // The batch queue owns the ffmpeg concurrency, so it must not race a single
    // export (and vice versa) — same single-flight rule, separate slots.
    if (exportInFlight) throw new Error('An export is already running — finish it first')
    exportInFlight = true
    try {
      return await runBatch(req)
    } finally {
      exportInFlight = false
    }
  })

  handle('shortz:cancelBatch', async (jobId?: string): Promise<void> => {
    cancelBatchRun(jobId)
  })

  // --- shell ------------------------------------------------------------------

  handle('shortz:revealInExplorer', async (p: string) => {
    if (fss.existsSync(p)) {
      shell.showItemInFolder(p)
      return
    }
    // Fall back to the containing folder; surface a readable error when even
    // that is gone instead of failing silently.
    const dir = path.dirname(p)
    const err = await shell.openPath(dir)
    if (err) throw new Error(`Cannot open "${dir}": ${err}`)
  })

  handle('shortz:openUserTemplatesFolder', async () => {
    const dir = userTemplatesDir()
    await fsp.mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })

  // --- settings ---------------------------------------------------------------

  handle('shortz:getSettings', async (): Promise<Settings> => currentSettings())

  handle('shortz:saveSettings', async (s: Settings): Promise<Settings> => saveCurrentSettings(s))

  // --- engine info (settings modal) -------------------------------------------

  handle('shortz:ffmpegInfo', async () => {
    const binaries = await resolveBinariesWithSettings()
    return { source: binaries.source, version: binaries.version }
  })

  handle('shortz:appVersion', async () => app.getVersion())
}
