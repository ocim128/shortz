/**
 * THE shared IPC contract (docs/technical/project-structure.md §"IPC contract").
 * Hand-rolled typed bridge — no electron-trpc (decision locked, docs/03-tech-stack.md).
 *
 * The bridge stays node-free (the web tier typechecks the renderer against it);
 * only shapes from src/shared/template/types (pure TS) are imported. Probe and
 * export-history entries mirror the core store's interfaces — keep in sync when
 * those change. TemplateMeta.body carries the real shared Template so the
 * renderer runs the same layout engine as the render pipeline (tmp/NOTES-B.md
 * recorded the contract addition).
 */

import type { Template } from '../shared/template/types'

export type { Template }

// ---------------------------------------------------------------------------
// Projects — shape per docs/technical/data-storage.md §project.json
// ---------------------------------------------------------------------------

/** Probe snapshot (mirrors the core store's ProjectProbeSnapshot). */
export interface ProbeSnapshot {
  width: number
  height: number
  fps: number
  duration: number
  hasAudio: boolean
  videoCodec: string
 }

/** Export-history entry (mirrors the core store's ExportHistoryEntry). */
export interface ExportHistoryEntry {
  path: string
  createdAt: string
  durationSec: number
  sizeBytes: number
  encoder: string
  crf?: number
}

export interface Project {
  schemaVersion: 1
  id: string
  name: string
  createdAt: string
  updatedAt: string
  source: {
    path: string
    probe: ProbeSnapshot | null
    /** Set fresh by open/list when the source file is missing (re-link keeps values). */
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
  /** true when projects/<id>/thumb.jpg exists (generated at import). */
  thumbAvailable: boolean
}

// ---------------------------------------------------------------------------
// Templates — real, validated template bodies (docs/technical/template-schema.md)
// ---------------------------------------------------------------------------

/**
 * The documented contract only names `TemplateMeta`; the renderer additionally
 * needs the full body (slots/knobs/inputs) to run the shared Layout Engine for
 * preview (docs/02-architecture.md — Layout Engine runs in the renderer too).
 * Rather than add a second `getTemplate` channel, TemplateMeta carries the body.
 * Recorded in tmp/NOTES-B.md.
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
  body?: Template
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
  /** Orchestrator stage ('probe'|'resolve'|'overlay'|'render'|'finalize'|'done') when known. */
  stage?: string
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
// Engine info (settings modal — formerly engine-pending rows)
// ---------------------------------------------------------------------------

export interface FfmpegInfo {
  source: 'system' | 'bundled' | 'custom'
  version: string | null
}

export interface FfmpegTestResult {
  ok: boolean
  version: string | null
  source: 'system' | 'bundled' | 'custom'
}

export interface ProbeCacheInfo {
  entries: number
  bytes: number
}

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
  /** media:// URL for projects/<id>/thumb.jpg, or null when absent. */
  getThumbUrl(id: string): Promise<string | null>
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
  /** FFmpeg binary provenance + version for the Settings modal. */
  ffmpegInfo(): Promise<FfmpegInfo>
  ffmpegTest(): Promise<FfmpegTestResult>
  probeCacheInfo(): Promise<ProbeCacheInfo>
  probeCacheClear(): Promise<ProbeCacheInfo>
  /** app.getVersion() for the About section. */
  appVersion(): Promise<string>
  // UI shell (not in the documented ~14 — see tmp/NOTES-B.md)
  onMenuCommand(cb: (cmd: MenuCommand) => void): Unsubscribe
  /** Electron ≥32 removed File.path; webUtils.getPathForFile is the sandbox-safe replacement. */
  getPathForFile(file: File): string
}