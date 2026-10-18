/**
 * THE shared IPC contract (docs/technical/project-structure.md §"IPC contract").
 * Hand-rolled typed bridge — no electron-trpc (decision locked, docs/03-tech-stack.md).
 *
 * Types marked with TODO(integration) duplicate minimal shapes from
 * src/shared (Agent A's lane) until those files exist; they are replaced by
 * imports from src/shared at integration time.
 */

// ---------------------------------------------------------------------------
// Projects — shape per docs/technical/data-storage.md §project.json
// ---------------------------------------------------------------------------

/** TODO(integration): replace with src/shared import. */
export interface ProbeSnapshot {
  width: number
  height: number
  fps: number
  duration: number
  hasAudio: boolean
  videoCodec: string
}

/** TODO(integration): replace with src/shared import. */
export interface ExportHistoryEntry {
  path: string
  createdAt: string
  durationSec: number
  sizeBytes: number
  encoder: string
  crf: number
}

/** TODO(integration): replace with src/shared import. */
export interface Project {
  schemaVersion: 1
  id: string
  name: string
  createdAt: string
  updatedAt: string
  source: {
    path: string
    probe: ProbeSnapshot | null
    /** Set by the store when the source file is missing (re-link flow keeps values). */
    missing?: boolean
  }
  templateId: string
  values: {
    fields: Record<string, string>
    knobs: Partial<Record<string, unknown>>
  }
  trim: { start: number; end: number }
  audio: 'keep' | 'mute'
  exportHistory: ExportHistoryEntry[]
}

export interface ProjectMeta {
  id: string
  name: string
  templateId: string
  updatedAt: string
  sourceMissing: boolean
  /** true when a projects/<id>/thumb.jpg exists (mock: always false in M0). */
  thumbAvailable: boolean
}

// ---------------------------------------------------------------------------
// Templates — shape per docs/technical/template-schema.md
// ---------------------------------------------------------------------------

export type BackgroundStyle = 'black' | 'white' | 'darkGray' | 'blurVideo'

/** TODO(integration): replace with src/shared/template/types import. */
export interface KnobDef {
  id: string
  label: string
  default: unknown
  control: 'slider' | 'select' | 'toggle' | 'color'
  min?: number
  max?: number
  step?: number
  options?: { value: unknown; label: string }[]
}

/** TODO(integration): replace with src/shared/template/types import. */
export interface FieldDef {
  key: string
  label: string
  control: 'textarea'
  placeholder?: string
  maxLength?: number
  required?: boolean
  /** For the hook counter UI. */
  maxLines?: number
}

/** Video slot geometry (the only slot geometry the preview needs). */
export interface VideoSlotGeometry {
  x: number
  y: number
  width: number
  height: number
  fit: 'contain' | 'cover'
  cornerRadius: number
}

/** Text slot styling for the preview text layer. */
export interface TextSlotStyle {
  bindsTo: string
  x: number
  width: number
  anchor: { kind: 'fixed'; y: number; height: number } | { kind: 'aboveVideo'; gap: number; minY: number }
  fontFamily: 'inter' | 'poppins'
  fontWeight: 400 | 600 | 800
  fontSize: number
  fontSizeMin: number
  lineHeight: number
  color: string
  align: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
  maxLines: number
}

/**
 * The documented contract only names `TemplateMeta`; the renderer additionally
 * needs the full body (slots/knobs/inputs) to run the shared Layout Engine for
 * preview (docs/02-architecture.md — Layout Engine runs in the renderer too).
 * Rather than add a second `getTemplate` channel, TemplateMeta carries the
 * body. Recorded in tmp/NOTES-B.md.
 */
export interface TemplateMeta {
  id: string
  name: string
  description: string
  badge: 'built-in' | 'user'
  /** Invalid user templates are listed greyed with the validation error. */
  valid: boolean
  error?: string
  /** Absent on invalid templates. */
  body?: {
    canvas: { backgroundStyle: BackgroundStyle }
    safeZones: { top: number; right: number; bottom: number; left: number }
    videoSlot: VideoSlotGeometry
    textSlots: TextSlotStyle[]
    knobs: KnobDef[]
    inputs: FieldDef[]
  }
}

// ---------------------------------------------------------------------------
// Render / export
// ---------------------------------------------------------------------------

export interface ExportOptions {
  /** Absolute output dir; falls back to settings.output.dir when omitted. */
  outputDir?: string
  encoder?: string
  crf?: number
  fps?: number | 'source'
}

export interface ExportResult {
  jobId: string
  path: string
  durationSec: number
  sizeBytes: number
  encoder: string
  crf: number
}

/** Emitted over webContents.send('shortz:render:progress'). */
export interface RenderProgressEvent {
  jobId: string
  percent: number
  outTimeSec: number
  speed: number
  etaSec: number | null
  done: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Settings — shape per docs/technical/data-storage.md §settings.json
// ---------------------------------------------------------------------------

export interface Settings {
  schemaVersion: 1
  output: {
    dir: string
    filenamePattern: string
  }
  encoder: {
    preferred: 'auto' | 'libx264' | 'h264_nvenc' | 'h264_amf' | 'h264_qsv'
    crf: 17 | 18 | 20 | 23
    fps: 30 | 60 | 'source'
  }
  ffmpeg: {
    source: 'auto' | 'system' | 'bundled'
  }
  ui: {
    safeZonesDefault: boolean
    lastProjectId: string | null
  }
}

export type FontKey = 'inter-regular' | 'inter-semibold' | 'inter-extrabold' | 'poppins-semibold'

export type Unsubscribe = () => void

/** Menu-driven UI commands (main → renderer). */
export type MenuCommand = 'new-project' | 'open-settings' | 'about'

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export interface ShortzApi {
  // projects
  createProject(sourcePath: string): Promise<Project>
  listProjects(): Promise<ProjectMeta[]>
  openProject(id: string): Promise<Project>
  saveProject(p: Project): Promise<void>
  deleteProject(id: string): Promise<void>
  relinkSource(id: string, newPath: string): Promise<Project>
  // media
  pickFile(): Promise<string | null>
  getMediaUrl(sourcePath: string): Promise<string>
  getFontBuffer(key: FontKey): Promise<Uint8Array>
  // templates
  listTemplates(): Promise<TemplateMeta[]>
  // render
  exportProject(p: Project, opts: ExportOptions): Promise<ExportResult>
  cancelExport(jobId: string): Promise<void>
  onRenderProgress(cb: (e: RenderProgressEvent) => void): Unsubscribe
  // shell
  revealInExplorer(path: string): Promise<void>
  openUserTemplatesFolder(): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>
  // UI shell (not in the documented ~14 — see tmp/NOTES-B.md)
  onMenuCommand(cb: (cmd: MenuCommand) => void): Unsubscribe
  /** Electron ≥32 removed File.path; webUtils.getPathForFile is the sandbox-safe replacement. */
  getPathForFile(file: File): string
}
