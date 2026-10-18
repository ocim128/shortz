import fsp from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import type { Project, ProjectMeta } from '../preload/api'
import {
  createProjectDocument,
  loadProjectDocument,
  saveProjectDocument,
  validateProjectDocument,
  type ProjectDocument
} from '../core/store/projects'
import type { ClipMeta } from '../core/ffmpeg/probe'
import { rmWithRetry } from '../core/store/fs-utils'

/**
 * Wire (renderer) ⇄ document (core store) mapping + project.json CRUD glue.
 * The wire Project carries required trim/exportHistory + a probe snapshot
 * (or null) exactly per docs/technical/data-storage.md §project.json.
 */

export function defaultTemplateId(): string {
  return 'hook-letterbox'
}

/** Doc → wire. `missing` is computed fresh at each open/list (never stale). */
export function toWireProject(doc: ProjectDocument, missing: boolean): Project {
  return {
    schemaVersion: 1,
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    source: {
      path: doc.source.path,
      probe: doc.source.probe ?? null,
      ...(missing ? { missing: true } : {})
    },
    templateId: doc.templateId,
    values: {
      fields: { ...doc.values.fields },
      knobs: { ...(doc.values.knobs as Partial<Record<string, unknown>>) }
    },
    trim: { ...(doc.trim ?? { start: 0, end: 0 }) },
    audio: doc.audio ?? 'keep',
    exportHistory: [...(doc.exportHistory ?? [])]
  }
}

/** Wire → doc, stripping the computed `source.missing` flag before persisting. */
export function toDocument(p: Project): ProjectDocument {
  const { schemaVersion, id, name, createdAt, updatedAt, source, templateId, values, trim, audio, exportHistory } = p
  const probe = source.probe
    ? {
        width: source.probe.width,
        height: source.probe.height,
        fps: source.probe.fps,
        duration: source.probe.duration,
        hasAudio: source.probe.hasAudio,
        videoCodec: source.probe.videoCodec
      }
    : undefined
  const doc: ProjectDocument = {
    schemaVersion,
    id,
    name,
    createdAt,
    updatedAt,
    source: { path: source.path, ...(probe ? { probe } : {}) },
    templateId,
    values: { fields: { ...values.fields }, knobs: { ...(values.knobs as ProjectDocument['values']['knobs']) } },
    ...(trim && trim.end > trim.start ? { trim: { ...trim } } : {}),
    audio,
    exportHistory: [...exportHistory]
  }
  return doc
}

export function probeSnapshot(meta: ClipMeta): {
  width: number
  height: number
  fps: number
  duration: number
  hasAudio: boolean
  videoCodec: string
} {
  return {
    width: meta.width,
    height: meta.height,
    fps: Math.round(meta.fps * 100) / 100,
    duration: Math.round(meta.durationSec * 1000) / 1000,
    hasAudio: meta.hasAudio,
    videoCodec: meta.videoCodec
  }
}

export async function sourceMissing(sourcePath: string): Promise<boolean> {
  const st = await fsp.stat(sourcePath).catch(() => null)
  return !(st && st.isFile())
}

export function toMeta(doc: ProjectDocument, missing: boolean, hasThumb: boolean): ProjectMeta {
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
 * quarantined as project.corrupt-<ts>.json (data-storage doc §concurrency).
 * Returns null so the lister skips it.
 */
export async function loadProjectSafe(projectsRoot: string, id: string): Promise<ProjectDocument | null> {
  const file = path.join(projectsRoot, id, 'project.json')
  try {
    return await loadProjectDocument(file)
  } catch (error) {
    console.warn(`[shortz] project ${id} unreadable — quarantining: ${(error as Error).message}`)
    if (fss.existsSync(file)) {
      const corrupt = path.join(projectsRoot, id, `project.corrupt-${Date.now()}.json`)
      await fsp.rename(file, corrupt).catch(() => undefined)
    }
    return null
  }
}

export async function saveProjectDocumentTo(
  projectsRoot: string,
  doc: ProjectDocument
): Promise<ProjectDocument> {
  return saveProjectDocument(doc, path.join(projectsRoot, doc.id, 'project.json'))
}

// --- lifecycle ---------------------------------------------------------------

export async function deleteProjectDir(projectsRoot: string, id: string): Promise<void> {
  const dir = path.join(projectsRoot, id)
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
  probe?: { width: number; height: number; fps: number; duration: number; hasAudio: boolean; videoCodec: string }
  templateId?: string
}): ProjectDocument {
  const doc = createProjectDocument({
    name: input.name,
    sourcePath: input.sourcePath,
    templateId: input.templateId ?? defaultTemplateId(),
    values: { fields: { hook: '' }, knobs: {} },
    trim: input.probe ? { start: 0, end: round2(input.probe.duration) } : undefined,
    audio: 'keep'
  })
  if (input.probe) doc.source.probe = input.probe
  return doc
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Clamp/repair trim against a (possibly new) probed duration — used at create
 * (fresh trim) and on relink (the reprobe may change the duration).
 */
export function repairTrim(doc: ProjectDocument, durationSec: number): void {
  const dur = Math.max(0.1, round2(durationSec))
  const existing = doc.trim
  if (!existing || existing.end <= existing.start || existing.start < 0) {
    doc.trim = { start: 0, end: dur }
    return
  }
  const start = Math.min(existing.start, Math.max(0, dur - 0.1))
  const end = Math.max(start + 0.1, Math.min(existing.end, dur))
  doc.trim = { start: round2(start), end: round2(end) }
}

/** Re-check a doc through the store validator so saves stay autosave-compatible. */
export function validateForSave(doc: ProjectDocument): ProjectDocument {
  return validateProjectDocument(doc, 'project.json')
}
