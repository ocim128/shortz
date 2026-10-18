import { promises as fs } from 'node:fs'
import { ulid } from 'ulid'
import type { KnobId } from '../../shared/template/knob-registry'
import { atomicWriteFile, stripBom } from './fs-utils'

export interface ProjectProbeSnapshot {
  width: number
  height: number
  fps: number
  duration: number
  hasAudio: boolean
  videoCodec: string
}

export interface ProjectSource {
  path: string
  probe?: ProjectProbeSnapshot
}

export interface ProjectValues {
  fields: Record<string, string>
  knobs: Partial<Record<KnobId, unknown>>
}

export interface ExportHistoryEntry {
  path: string
  createdAt: string
  durationSec: number
  sizeBytes: number
  encoder: string
  crf?: number
}

export interface ProjectDocument {
  schemaVersion: 1
  id: string
  name: string
  createdAt: string
  updatedAt: string
  source: ProjectSource
  templateId: string
  values: ProjectValues
  trim?: { start: number; end: number }
  audio: 'keep' | 'mute'
  exportHistory?: ExportHistoryEntry[]
}

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
  values?: ProjectValues
  audio?: 'keep' | 'mute'
  trim?: { start: number; end: number }
}): ProjectDocument {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: ulid(),
    name: input.name,
    createdAt: now,
    updatedAt: now,
    source: { path: input.sourcePath },
    templateId: input.templateId,
    values: input.values ?? { fields: {}, knobs: {} },
    ...(input.trim ? { trim: input.trim } : {}),
    audio: input.audio ?? 'keep',
    exportHistory: []
  }
}

export function validateProjectDocument(raw: unknown, filePath: string): ProjectDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectFileError(filePath, 'project.json must be a JSON object')
  }
  const doc = raw as Partial<ProjectDocument>
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
      doc.trim.end <= doc.trim.start
    ) {
      throw new ProjectFileError(filePath, 'trim must satisfy end > start')
    }
  }
  return raw as ProjectDocument
}

export async function loadProjectDocument(filePath: string): Promise<ProjectDocument> {
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
  return validateProjectDocument(parsed, filePath)
}

export async function saveProjectDocument(
  project: ProjectDocument,
  filePath: string
): Promise<ProjectDocument> {
  const updated: ProjectDocument = { ...project, updatedAt: new Date().toISOString() }
  await atomicWriteFile(filePath, `${JSON.stringify(updated, null, 2)}\n`)
  return updated
}
