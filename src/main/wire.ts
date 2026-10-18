import fsp from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type { Project, ProjectMeta, ProjectProbeSnapshot } from '../shared/domain'
import { createProjectDocument, loadProjectDocument, saveProjectDocument } from '../core/store/projects'
import type { ClipMeta } from '../core/ffmpeg/probe'
import { logWarn } from '../core/log'
import { rmWithRetry } from '../core/store/fs-utils'

/**
 * project.json CRUD glue + the small open/list computations (missing-source
 * flag, list metas, trim repair). With the canonical shared `Project` type
 * there is no wire⇄document mapping left — documents cross IPC as-is.
 */

export function defaultTemplateId(): string {
  return 'hook-letterbox'
}

/** Round a probed ClipMeta down to the persisted snapshot (3-decimal fps/duration). */
export function probeSnapshot(meta: ClipMeta): ProjectProbeSnapshot {
  return {
    width: meta.width,
    height: meta.height,
    // 3 decimals keeps NTSC rates distinguishable (23.976, 29.97, 59.94);
    // display-side snapping to canonical rates lives in the renderer.
    fps: Math.round(meta.fps * 1000) / 1000,
    duration: Math.round(meta.durationSec * 1000) / 1000,
    hasAudio: meta.hasAudio,
    videoCodec: meta.videoCodec
  }
}

export async function sourceMissing(sourcePath: string): Promise<boolean> {
  const st = await fsp.stat(sourcePath).catch(() => null)
  return !(st && st.isFile())
}

export function toMeta(doc: Project, missing: boolean, hasThumb: boolean): ProjectMeta {
  return {
    id: doc.id,
    name: doc.name,
    templateId: doc.templateId,
    updatedAt: doc.updatedAt,
    sourceMissing: missing,
    thumbAvailable: hasThumb
  }
}

// --- project.json CRUD (data dir projects/<id>/) ---------------------------

export async function listProjectIds(projectsRoot: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(projectsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}

/**
 * Load a project document; on an unreadable/corrupt project.json, the file is
 * quarantined as project.corrupt-<ts>.json. Returns null so the lister skips it.
 */
export async function loadProjectSafe(projectsRoot: string, id: string): Promise<Project | null> {
  const file = path.join(projectsRoot, id, 'project.json')
  try {
    return await loadProjectDocument(file)
  } catch (error) {
    logWarn(`[shortz] project ${id} unreadable — quarantining: ${(error as Error).message}`)
    if (fss.existsSync(file)) {
      const corrupt = path.join(projectsRoot, id, `project.corrupt-${Date.now()}.json`)
      await fsp.rename(file, corrupt).catch(() => undefined)
    }
    return null
  }
}

export async function saveProjectDocumentTo(projectsRoot: string, doc: Project): Promise<Project> {
  return saveProjectDocument(doc, path.join(projectsRoot, doc.id, 'project.json'))
}

// --- lifecycle ---------------------------------------------------------------

export async function deleteProjectDir(projectsRoot: string, id: string): Promise<void> {
  // Same containment rule as data.ts projectDir — this is the destructive path.
  const root = path.resolve(projectsRoot)
  const dir = path.resolve(root, id)
  if (!dir.startsWith(root + path.sep)) {
    throw new Error(`Invalid project id: ${id}`)
  }
  if (!fss.existsSync(dir)) return
  try {
    // Doc rule: recycle bin when possible, else plain delete (exports untouched).
    await shell.trashItem(dir)
  } catch {
    await rmWithRetry(dir)
  }
}

export function newProjectDocument(input: {
  name: string
  sourcePath: string
  probe?: ProjectProbeSnapshot
  templateId?: string
}): Project {
  const doc = createProjectDocument({
    name: input.name,
    sourcePath: input.sourcePath,
    templateId: input.templateId ?? defaultTemplateId(),
    values: { fields: { hook: '' }, knobs: {} },
    trim: input.probe
      ? { start: 0, end: Math.round(input.probe.duration * 100) / 100 }
      : undefined,
    audio: 'keep'
  })
  if (input.probe) doc.source.probe = input.probe
  return doc
}

/**
 * Clamp/repair trim against a (possibly new) probed duration — used at create
 * (fresh trim) and on relink (the reprobe may change the duration).
 */
export function repairTrim(doc: Project, durationSec: number): void {
  const dur = Math.max(0.1, Math.round(durationSec * 100) / 100)
  const existing = doc.trim
  if (!existing || existing.end <= existing.start || existing.start < 0) {
    doc.trim = { start: 0, end: dur }
    return
  }
  const start = Math.min(existing.start, Math.max(0, dur - 0.1))
  const end = Math.max(start + 0.1, Math.min(existing.end, dur))
  doc.trim = { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 }
}
