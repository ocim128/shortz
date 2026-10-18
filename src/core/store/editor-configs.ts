import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ulid } from 'ulid'
import { isPlainObject, type EditorConfig, type EditorConfigMeta } from '../../shared/domain'
import { assertProjectId } from './projects'
import { atomicWriteFile, rmWithRetry, stripBom } from './fs-utils'

/**
 * Named editor configurations — everything the user tweaks in the editor that
 * is NOT tied to the specific clip: template choice, text fields, knob values,
 * trim and audio. Stored as one JSON per config under
 * <dataDir>/editor-configs/<id>.json (id = ULID), so in-app Save/Load/Delete
 * need no file dialogs.
 */

export const EDITOR_CONFIG_NAME_MAX = 60

export function editorConfigsDir(dataDir: string): string {
  return path.join(dataDir, 'editor-configs')
}

function configFilePath(dataDir: string, id: string): string {
  // ULID guard — an id must never resolve outside the configs dir.
  assertProjectId(id)
  return path.join(editorConfigsDir(dataDir), `${id}.json`)
}

/**
 * Validate an untrusted parsed document. Throws a readable error naming the
 * bad part — the renderer surfaces it in a toast so a corrupt file is never
 * mistaken for a missing config.
 */
export function sanitizeEditorConfig(raw: unknown): EditorConfig {
  if (!isPlainObject(raw)) throw new Error('editor config: not a JSON object')
  const { name, templateId, values, trim, audio } = raw

  if (typeof name !== 'string') throw new Error('editor config: name must be a string')
  const trimmedName = name.trim()
  if (trimmedName.length === 0) throw new Error('editor config: name must not be empty')
  if (trimmedName.length > EDITOR_CONFIG_NAME_MAX) {
    throw new Error(`editor config: name longer than ${EDITOR_CONFIG_NAME_MAX} characters`)
  }

  if (typeof templateId !== 'string' || templateId.length === 0) {
    throw new Error('editor config: templateId must be a non-empty string')
  }
  if (!isPlainObject(values)) throw new Error('editor config: values must be an object')
  const fields = values.fields
  const knobs = values.knobs
  if (!isPlainObject(fields)) throw new Error('editor config: values.fields must be an object')
  const fieldsOut: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string') throw new Error(`editor config: field "${key}" must be a string`)
    fieldsOut[key] = value
  }
  if (!isPlainObject(knobs)) throw new Error('editor config: values.knobs must be an object')

  if (!isPlainObject(trim)) throw new Error('editor config: trim must be an object')
  const { start, end } = trim
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) {
    throw new Error('editor config: trim.start must be a non-negative number')
  }
  if (typeof end !== 'number' || !Number.isFinite(end) || end <= start) {
    throw new Error('editor config: trim.end must be a number greater than trim.start')
  }

  if (audio !== 'keep' && audio !== 'mute') {
    throw new Error('editor config: audio must be "keep" or "mute"')
  }

  if (typeof raw.savedAt !== 'string' || Number.isNaN(Date.parse(raw.savedAt))) {
    throw new Error('editor config: savedAt must be an ISO date string')
  }

  return {
    schemaVersion: 1,
    name: trimmedName,
    savedAt: raw.savedAt,
    templateId,
    values: { fields: fieldsOut, knobs },
    trim: { start, end },
    audio
  }
}

/** List saved configs, newest first. Corrupt files are skipped, not fatal. */
export async function listEditorConfigs(dataDir: string): Promise<EditorConfigMeta[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(editorConfigsDir(dataDir))
  } catch {
    return []
  }
  const metas: EditorConfigMeta[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) continue
    try {
      const raw = JSON.parse(
        stripBom(await fs.readFile(path.join(editorConfigsDir(dataDir), entry), 'utf8'))
      )
      const config = sanitizeEditorConfig(raw)
      metas.push({ id, name: config.name, savedAt: config.savedAt })
    } catch {
      // A corrupt file must not hide the healthy configs; it stays on disk
      // until the user re-saves over its name or deletes it.
    }
  }
  return metas.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/**
 * Save a config. Names are the unique key (case-insensitive): saving with an
 * existing name updates that config in place; otherwise a new one is minted.
 * Returns the stored meta (id + fresh savedAt).
 */
export async function saveEditorConfig(
  config: Omit<EditorConfig, 'savedAt'> & { savedAt?: string },
  dataDir: string
): Promise<EditorConfigMeta> {
  const name = typeof config.name === 'string' ? config.name.trim() : ''
  const existing = await listEditorConfigs(dataDir)
  const match = existing.find((m) => m.name.toLowerCase() === name.toLowerCase())
  const id = match ? match.id : ulid()
  const doc = sanitizeEditorConfig({ ...config, name, savedAt: new Date().toISOString() })
  await atomicWriteFile(configFilePath(dataDir, id), `${JSON.stringify({ id, ...doc }, null, 2)}\n`)
  return { id, name: doc.name, savedAt: doc.savedAt }
}

/** Load one config by id. Throws a readable error when missing or corrupt. */
export async function loadEditorConfig(id: string, dataDir: string): Promise<EditorConfig> {
  const file = configFilePath(dataDir, id)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No saved configuration with id ${id}`)
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(text))
  } catch {
    throw new Error(
      `Saved configuration "${path.basename(file)}" is not valid JSON — save again to replace it`
    )
  }
  // The id lives only in the filename; keep the two in sync on the way out.
  return sanitizeEditorConfig(parsed)
}

export async function deleteEditorConfig(id: string, dataDir: string): Promise<void> {
  await rmWithRetry(configFilePath(dataDir, id))
}
