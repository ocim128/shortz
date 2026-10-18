import { promises as fs } from 'node:fs'
import { ulid } from 'ulid'
import type { Project } from '../../shared/domain'
import { atomicWriteFile, stripBom } from './fs-utils'

export class ProjectFileError extends Error {
  readonly filePath: string

  constructor(filePath: string, message: string) {
    super(message)
    this.name = 'ProjectFileError'
    this.filePath = filePath
  }
}

/**
 * Project ids are ULIDs (Crockford Base32, 26 chars) minted by
 * createProjectDocument — anything else arriving from a renderer is joined
 * into filesystem paths and must be rejected outright.
 */
export const PROJECT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function isProjectId(id: unknown): id is string {
  return typeof id === 'string' && PROJECT_ID_RE.test(id)
}

/** IPC-boundary guard: never trust a renderer-supplied project id. */
export function assertProjectId(id: unknown): asserts id is string {
  if (!isProjectId(id)) {
    throw new Error(`Invalid project id: ${String(id)}`)
  }
}

export function createProjectDocument(input: {
  name: string
  sourcePath: string
  templateId: string
  values?: Project['values']
  audio?: 'keep' | 'mute'
  trim?: { start: number; end: number }
}): Project {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: ulid(),
    name: input.name,
    createdAt: now,
    updatedAt: now,
    source: { path: input.sourcePath, probe: null },
    templateId: input.templateId,
    values: input.values ?? { fields: {}, knobs: {} },
    trim: input.trim ?? { start: 0, end: 0 },
    audio: input.audio ?? 'keep'
  }
}

export function validateProjectDocument(raw: unknown, filePath: string): Project {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectFileError(filePath, 'project.json must be a JSON object')
  }
  const doc = raw as Partial<Project>
  if (doc.schemaVersion !== 1) {
    throw new ProjectFileError(filePath, `unsupported schemaVersion ${String(doc.schemaVersion)}`)
  }
  if (typeof doc.source?.path !== 'string' || doc.source.path.length === 0) {
    throw new ProjectFileError(filePath, 'source.path is required')
  }
  if (typeof doc.templateId !== 'string' || doc.templateId.length === 0) {
    throw new ProjectFileError(filePath, 'templateId is required')
  }
  if (
    doc.values === undefined ||
    typeof doc.values.fields !== 'object' ||
    doc.values.fields === null
  ) {
    throw new ProjectFileError(filePath, 'values.fields is required')
  }
  if (
    doc.values.knobs === undefined ||
    typeof doc.values.knobs !== 'object' ||
    doc.values.knobs === null
  ) {
    throw new ProjectFileError(filePath, 'values.knobs is required')
  }
  if (doc.audio !== undefined && doc.audio !== 'keep' && doc.audio !== 'mute') {
    throw new ProjectFileError(filePath, "audio must be 'keep' or 'mute'")
  }
  if (doc.trim !== undefined) {
    if (
      typeof doc.trim.start !== 'number' ||
      typeof doc.trim.end !== 'number' ||
      !Number.isFinite(doc.trim.start) ||
      !Number.isFinite(doc.trim.end) ||
      doc.trim.start < 0
    ) {
      throw new ProjectFileError(filePath, 'trim must satisfy start >= 0')
    }
    // {0,0} is the documented "no trim" value; anything else must be ordered.
    const unset = doc.trim.start === 0 && doc.trim.end === 0
    if (!unset && doc.trim.end <= doc.trim.start) {
      throw new ProjectFileError(filePath, 'trim must satisfy end > start')
    }
  }
  return raw as Project
}

export async function loadProjectDocument(filePath: string): Promise<Project> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    throw new ProjectFileError(filePath, `could not read project file: ${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(text))
  } catch (error) {
    throw new ProjectFileError(filePath, `invalid JSON: ${(error as Error).message}`)
  }
  const doc = validateProjectDocument(parsed, filePath)
  // Normalize legacy documents so the in-memory shape is total: missing trim
  // means the full clip, probe null means "unknown", and a persisted
  // `missing` hint (never written by this version) is dropped — open/list
  // recompute it fresh anyway.
  doc.trim ??= { start: 0, end: 0 }
  if (doc.source.probe == null) doc.source.probe = null
  delete doc.source.missing
  return doc
}

export async function saveProjectDocument(project: Project, filePath: string): Promise<Project> {
  validateProjectDocument(project, filePath)
  // The computed `missing` flag never persists.
  const { missing: _missing, ...source } = project.source
  const updated: Project = { ...project, source, updatedAt: new Date().toISOString() }
  await atomicWriteFile(filePath, `${JSON.stringify(updated, null, 2)}\n`)
  return updated
}
