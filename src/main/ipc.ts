import fsp from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import type {
  ExportOptions,
  ExportResult,
  FontKey,
  Project,
  ProjectMeta,
  RenderProgressEvent,
  Settings,
  TemplateMeta
} from '../preload/api'
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
  toDocument,
  toMeta,
  toWireProject,
  validateForSave
} from './wire'
import { listTemplates as listTemplateFiles, loadTemplateById } from '../core/store/templates'
import { assertProjectId } from '../core/store/projects'
import { describeTemplateIssues, type ValidationIssue } from '../shared/template/validate'
import type { Template } from '../shared/template/types'
import { resolveFfmpegBinariesCached, type FfmpegSourcePreference } from '../core/ffmpeg/resolve-bin'
import { probeWithCache } from '../core/ffmpeg/probe'
import { generateThumbnail } from '../core/media/thumbnail'
import { renderProject, defaultTmpRoot } from '../core/render/orchestrator'
import type { OrchestratorProgress } from '../core/render/orchestrator'
import { saveSettings as saveSettingsDoc, loadSettings } from '../core/store/settings'
import { rmWithRetry } from '../core/store/fs-utils'
import { logWarn } from '../core/log'

/**
 * Typed IPC handlers — the real product wiring (docs/technical/project-structure.md
 * §"IPC contract" + tmp/NOTES-B.md integration checklist).
 * Shell/media methods stay as B built them; everything engine-shaped now goes
 * through src/core (the render engine + stores).
 */

const FONT_FILES: Record<FontKey, string> = {
  'inter-regular': 'Inter-Regular.ttf',
  'inter-semibold': 'Inter-SemiBold.ttf',
  'inter-extrabold': 'Inter-ExtraBold.ttf',
  'poppins-semibold': 'Poppins-SemiBold.ttf'
}

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
  return resolveFfmpegBinariesCached({ preference: settings.ffmpeg.source as FfmpegSourcePreference })
}

// One render at a time (the renderer's store models a single job).
const activeAborts = new Map<string, AbortController>()
let exportInFlight = false

// --- output filename (docs/technical/export-spec.md §filename convention) ----

function sanitizeNamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').trim()
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function outputPathFor(project: Project, templateId: string, dir: string, pattern: string): string {
  const now = new Date()
  const tokens: Record<string, string> = {
    name: sanitizeNamePart(project.name),
    template: sanitizeNamePart(templateId),
    date: `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`,
    time: `${pad2(now.getHours())}${pad2(now.getMinutes())}`,
    seq: '1',
    yyyyMMdd: `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`,
    HHmm: `${pad2(now.getHours())}${pad2(now.getMinutes())}`
  }
  let base = ''
  const tokensRe = /\{(\w+)\}/g
  let last = 0
  for (const m of pattern.matchAll(tokensRe)) {
    const key = m[1] as string
    base += pattern.slice(last, m.index ?? 0)
    base += sanitizeNamePart(tokens[key] ?? `{${key}}`)
    last = (m.index ?? 0) + m[0].length
  }
  base += pattern.slice(last)
  base = sanitizeNamePart(base).replace(/^_+|_+$/g, '').slice(0, 80)
  if (base.length === 0) base = 'export'
  return path.join(dir, `${base}.mp4`)
}

// --- progress mapping --------------------------------------------------------

function parseSpeed(raw: string | null | undefined): number {
  if (!raw) return 0
  const m = raw.match(/([\d.]+)x?/)
  if (!m) return 0
  const v = Number(m[1])
  return Number.isFinite(v) ? v : 0
}

function toProgressEvent(p: OrchestratorProgress, durationSec: number): RenderProgressEvent {
  const speed = parseSpeed(p.speed)
  const pct = p.pct < 0 ? 0 : p.pct > 100 ? 100 : Math.round(p.pct)
  const done = p.stage === 'done'
  let etaSec: number | null = null
  if (!done && speed > 0 && p.outTimeSec !== undefined && durationSec > p.outTimeSec) {
    etaSec = (durationSec - p.outTimeSec) / speed
  }
  return {
    jobId: p.jobId,
    percent: pct,
    outTimeSec: p.outTimeSec ?? 0,
    speed,
    etaSec,
    done,
    stage: p.stage
  }
}

type WireTemplateMeta = TemplateMeta
type CoreTemplateMeta = {
  id: string
  name: string
  description: string
  thumbnail: string
  sourcePath: string
  valid: boolean
  issues: ValidationIssue[]
  template?: Template
}

function wireTemplateMeta(m: CoreTemplateMeta, badge: 'built-in' | 'user'): WireTemplateMeta {
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

  const preferred = opts.encoder ?? settings.encoder.preferred
  // amf/qsv variants are settings-visible but outside the v1 arg-builder union —
  // fall back to software with a logged note rather than failing the export.
  const encoder = preferred === 'h264_nvenc' ? 'h264_nvenc' : 'libx264'
  if (encoder !== preferred) {
    logWarn(`[shortz] encoder "${preferred}" unsupported in v1 — using ${encoder}`)
  }
  const crf = opts.crf ?? settings.encoder.crf

  const outDir = opts.outputDir ?? settings.output.dir
  const outputTarget = outputPathFor(p, template.id, outDir, settings.output.filenamePattern)

  const doc = toDocument(p)
  const trim = doc.trim && doc.trim.end > doc.trim.start && doc.trim.start >= 0 ? doc.trim : undefined
  const jobDoc: Project = trim ? p : { ...p, trim: { start: 0, end: 0 } }

  // Eta math needs the trimmed duration: probe snapshot when present, else 0 (no eta).
  const durationForEta = doc.source.probe?.duration ?? 0

  const controller = new AbortController()
  try {
    const result = await renderProject({
      project: {
        ...toDocument(jobDoc),
        trim: trim ? trim : undefined,
        source: { path: jobDoc.source.path, probe: doc.source.probe ? { ...doc.source.probe } : undefined }
      },
      template,
      outputPath: outputTarget,
      resourcesDir: resources,
      tmpRoot: defaultTmpRoot(),
      encoder,
      crf,
      ...(fpsOverride !== undefined ? { fps: fpsOverride } : {}),
      ffmpegPath: binaries.ffmpegPath,
      ffprobePath: binaries.ffprobePath,
      probeCacheDir: probeCachesDir(),
      signal: controller.signal,
      onProgress: (progress) => {
        activeAborts.set(progress.jobId, controller)
        sendToRenderer('shortz:render:progress', toProgressEvent(progress, durationForEta))
      }
    })

    activeAborts.delete(result.jobId)
    sendToRenderer('shortz:render:progress', {
      jobId: result.jobId,
      percent: 100,
      outTimeSec: result.durationSec,
      speed: 0,
      etaSec: 0,
      done: true,
      stage: 'done'
    })

    // exportHistory — load-modify-save the FRESH document so concurrent renderer
    // autosaves don't clobber the entry.
    const fresh = await loadProjectSafe(projectsRoot(), doc.id)
    if (fresh) {
      fresh.exportHistory = [
        ...(fresh.exportHistory ?? []),
        {
          path: result.outputPath,
          createdAt: new Date().toISOString(),
          durationSec: Math.round(result.durationSec * 1000) / 1000,
          sizeBytes: result.sizeBytes,
          encoder: result.videoCodec,
          crf
        }
      ]
      await saveProjectDocumentTo(projectsRoot(), validateForSave(fresh))
    }

    return {
      jobId: result.jobId,
      path: result.outputPath,
      durationSec: Math.round(result.durationSec * 1000) / 1000,
      sizeBytes: result.sizeBytes,
      encoder: result.videoCodec,
      crf
    }
  } finally {
    activeAborts.clear()
  }
}

export function registerIpcHandlers(): void {
  // --- projects ---------------------------------------------------------------

  handle('shortz:createProject', async (sourcePath: string): Promise<Project> => {
    const abs = path.resolve(sourcePath)
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat || !stat.isFile()) throw new Error(`File not found: ${abs}`)

    // ffprobe at import (docs: probe snapshot + default trim = full clip).
    const binaries = await resolveBinariesWithSettings()
    const clip = await probeWithCache(abs, {
      ffprobePath: binaries.ffprobePath,
      cacheDir: probeCachesDir()
    })
    const probe = probeSnapshot(clip)

    const doc = newProjectDocument({
      name: path.basename(abs, path.extname(abs)),
      sourcePath: abs,
      probe
    })
    await saveProjectDocumentTo(projectsRoot(), validateForSave(doc))

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

    return toWireProject(doc, false)
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
    return toWireProject(doc, await sourceMissing(doc.source.path))
  })

  handle('shortz:saveProject', async (p: Project): Promise<void> => {
    assertProjectId(p.id)
    // Recreate the folder if something (a delete from Explorer) removed it below
    // an in-flight autosave; normal saves silence nothing.
    if (!fss.existsSync(projectFilePath(p.id))) {
      await fsp.mkdir(projectDir(p.id), { recursive: true })
    }
    await saveProjectDocumentTo(projectsRoot(), validateForSave(toDocument(p)))
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
    const saved = await saveProjectDocumentTo(projectsRoot(), validateForSave(doc))
    return toWireProject(saved, false)
  })

  // --- media ------------------------------------------------------------------

  handle('shortz:pickFile', async () => {
    const result = await dialog.showOpenDialog(firstWindow()!, {
      title: 'Choose a video',
      properties: ['openFile'],
      filters: [
        { name: 'Videos', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', 'ts'] }
      ]
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

  handle('shortz:cancelExport', async (jobId: string): Promise<void> => {
    activeAborts.get(jobId)?.abort()
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

  handle('shortz:getSettings', async (): Promise<Settings> => (await loadSettings(dataDir())) as unknown as Settings)

  handle('shortz:saveSettings', async (s: Settings): Promise<Settings> => {
    await saveSettingsDoc(s as Parameters<typeof saveSettingsDoc>[0], dataDir())
    return (await loadSettings(dataDir())) as unknown as Settings
  })

  // --- engine info (settings modal — formerly engine-pending rows) -------------

  handle('shortz:ffmpegInfo', async () => {
    const binaries = await resolveBinariesWithSettings()
    return { source: binaries.source, version: binaries.version }
  })

  handle('shortz:ffmpegTest', async () => {
    const binaries = await resolveBinariesWithSettings()
    return { ok: binaries.version !== null, version: binaries.version, source: binaries.source }
  })

  handle('shortz:probeCacheInfo', async (): Promise<{ entries: number; bytes: number }> => {
    const dir = probeCachesDir()
    let entries: string[]
    try {
      entries = await fsp.readdir(dir)
    } catch {
      return { entries: 0, bytes: 0 }
    }
    let bytes = 0
    for (const f of entries.filter((e) => e.endsWith('.json'))) {
      const st = await fsp.stat(path.join(dir, f)).catch(() => null)
      if (st) bytes += st.size
    }
    return { entries: entries.filter((e) => e.endsWith('.json')).length, bytes }
  })

  handle('shortz:probeCacheClear', async () => {
    await rmWithRetry(probeCachesDir())
    return { entries: 0, bytes: 0 }
  })

  handle('shortz:appVersion', async () => app.getVersion())
}
