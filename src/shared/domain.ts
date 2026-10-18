import type { KnobId } from './template/knob-registry'

/**
 * Canonical cross-process data shapes: project, settings, editor configs.
 * ONE type serves as both the on-disk document and the IPC wire value — the
 * store normalizes on load (trim/probe defaults, dropping computed flags), so
 * no mapping layer sits between main and the renderer. `source.missing` is a
 * fresh-at-open hint only; it is stripped again on save.
 */

export interface ProjectProbeSnapshot {
  width: number
  height: number
  fps: number
  duration: number
  hasAudio: boolean
  videoCodec: string
}

export interface Project {
  schemaVersion: 1
  id: string
  name: string
  createdAt: string
  updatedAt: string
  source: {
    path: string
    probe: ProjectProbeSnapshot | null
    /** Computed at open/list by stat-ing the source; never persisted. */
    missing?: boolean
  }
  templateId: string
  values: {
    fields: Record<string, string>
    knobs: Partial<Record<KnobId, unknown>>
  }
  /** `{ start: 0, end: 0 }` means "full clip" (no trim). */
  trim: { start: number; end: number }
  audio: 'keep' | 'mute'
}

export interface ProjectMeta {
  id: string
  name: string
  templateId: string
  updatedAt: string
  sourceMissing: boolean
  /** true when projects/<id>/thumb.jpg exists (generated at import). */
  thumbAvailable: boolean
}

export interface Settings {
  schemaVersion: 1
  output: {
    dir: string
    filenamePattern: string
  }
  encoder: {
    preferred: 'auto' | 'libx264' | 'h264_nvenc'
    crf: 17 | 18 | 20 | 23
    fps: 30 | 60 | 'source'
  }
  ffmpeg: {
    source: 'auto' | 'system' | 'bundled'
  }
  ui: {
    safeZonesDefault: boolean
  }
}

/**
 * Everything the user tweaks in the editor that is not tied to the clip:
 * template + fields + knobs + trim + audio. Named slots — no file dialogs.
 */
export interface EditorConfig {
  schemaVersion: 1
  /** Display name — unique key: saving with an existing name updates it. */
  name: string
  /** ISO timestamp stamped on save. */
  savedAt: string
  templateId: string
  values: {
    fields: Record<string, string>
    knobs: Record<string, unknown>
  }
  trim: { start: number; end: number }
  audio: 'keep' | 'mute'
}

/** Listing entry — the body is fetched on demand via loadEditorConfig(id). */
export interface EditorConfigMeta {
  id: string
  name: string
  savedAt: string
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
