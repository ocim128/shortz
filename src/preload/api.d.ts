/**
 * THE shared IPC contract (docs/technical/project-structure.md §"IPC contract").
 * Hand-rolled typed bridge — no electron-trpc (decision locked, docs/03-tech-stack.md).
 *
 * The bridge stays node-free (the web tier typechecks the renderer against it);
 * data shapes come from src/shared/domain.ts (the same types the core stores
 * persist), and TemplateMeta.body carries the real shared Template so the
 * renderer runs the same layout engine as the render pipeline.
 */

import type { Template } from '../shared/template/types'
import type {
  EditorConfig,
  EditorConfigMeta,
  Project,
  ProjectMeta,
  ProjectProbeSnapshot,
  Settings
} from '../shared/domain'
import type { FontKey as BundledFontKey } from '../shared/layout/text'

export type {
  Template,
  EditorConfig,
  EditorConfigMeta,
  Project,
  ProjectMeta,
  ProjectProbeSnapshot,
  Settings
}

// ---------------------------------------------------------------------------
// Templates — real, validated template bodies (docs/technical/template-schema.md)
// ---------------------------------------------------------------------------

/**
 * The renderer needs the full body (slots/knobs/inputs) to run the shared
 * Layout Engine for preview, so TemplateMeta carries the body rather than a
 * second `getTemplate` channel.
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
// Batch — one textarea line (`path•hook`) = one rendered clip.
// Parsing lives in src/shared/batch/parse.ts so the renderer previews exactly
// what main will render.
// ---------------------------------------------------------------------------

/** One rendered line, as sent from the renderer. */
export interface BatchRenderItem {
  /** Stable per-line key from the parser (index-based). */
  id: string
  /** Absolute video path. */
  path: string
  /** Hook text for the template's hook input. */
  hook: string
}

export interface BatchRunRequest {
  items: BatchRenderItem[]
  /** Named editor config to take template + knobs (+ trim/audio) from. */
  configId?: string
  /** Template used when configId is absent. */
  templateId?: string
  /** Apply the config's trim range to every item (off = full clip). */
  configTrim?: boolean
  /** Output folder; falls back to settings.output.dir. */
  outputDir?: string
  fps?: number
  crf?: number
  audio?: 'keep' | 'mute'
}

export type BatchRenderItemStatus =
  'starting' | 'probing' | 'rendering' | 'done' | 'error' | 'skipped' | 'finished' | 'cancelled'

/** Emitted over webContents.send('shortz:batch:progress'). */
export interface BatchRenderEvent {
  jobId: string
  /** 0-based item index; equals total on the terminal event. */
  index: number
  total: number
  status: BatchRenderItemStatus
  /** Absent on the terminal event. */
  item?: BatchRenderItem
  /** 0–100 for the running item. */
  percent?: number
  /** Orchestrator stage when known. */
  stage?: string
  outputPath?: string
  durationSec?: number
  sizeBytes?: number
  error?: string
  /** Only on the terminal event. */
  completed?: number
  failed?: number
}

export interface BatchRunSummary {
  jobId: string
  total: number
  completed: number
  failed: number
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// Downloader (Twitter/X) — the data contract lives in
// src/shared/downloader/types.ts and is re-exported here so the renderer has
// one import site, exactly like BatchRunRequest above.
// ---------------------------------------------------------------------------

export type {
  DlChosenInfo,
  DlErrorCode,
  DlInput,
  DlItemStatus,
  DlListEntry,
  DlMediaState,
  DlQuality,
  DlRequest,
  DlSkipReason
} from '../shared/downloader/types'

/**
 * What main sends on 'shortz:dl:progress': the core event, de-coded and
 * enriched. Main renames the byte total's field (`mediaTotal`) so the top-level
 * `total` always means "items in the run", and fills `posterMediaUrl` +
 * `error` because the renderer never builds media:// URLs or error sentences.
 */
export interface DlProgressEvent {
  jobId: string
  /** The textarea line this event belongs to: 'line-<lineNumber>'. */
  key: string
  lineNumber: number
  /** 0-based position among the run's items; equals total on the terminal event. */
  index: number
  total: number
  kind: 'item' | 'media-progress' | 'run-done'
  item?: {
    tweetId: string
    status: DlItemStatus
    author?: string
    caption?: string
    /** Ready media:// URL for the cached poster — minted by main. */
    posterMediaUrl?: string
    plannedPaths?: string[]
    files?: string[]
    /** Human sentence from copy.ts — main phrases it, never the renderer. */
    error?: string
    errorCode?: DlErrorCode
    /** Raw detail for the tooltip/log; never the primary sentence. */
    errorDetail?: string
    skipReason?: DlSkipReason
    media?: DlMediaState[]
    /** Chosen variants (additive v1.1) — the row's resolution badge. */
    chosen?: DlChosenInfo[]
  }
  /** media-progress only: which media of the item, and its byte counters. */
  mediaIndex?: number
  bytes?: number
  mediaTotal?: number | null
  /** run-done only. */
  summary?: { ok: number; skipped: number; partial: number; failed: number; cancelled: number }
}

/**
 * The bundled TTF keys (see src/shared/layout/text.ts), plus 'emoji' — the
 * host platform's emoji font, served best-effort (empty bytes when the
 * platform has none; never throws).
 */
export type FontKey = BundledFontKey | 'emoji'

export type Unsubscribe = () => void

/** Menu-driven UI commands (main → renderer). */
export type MenuCommand = 'new-project' | 'open-settings'

/** FFmpeg binary provenance + version for the Settings modal. */
export interface FfmpegInfo {
  source: 'system' | 'bundled' | 'custom'
  version: string | null
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
  // editor configs (named slots under <dataDir>/editor-configs/, no file dialogs)
  /** Saving with an existing name updates that config in place. */
  saveEditorConfig(c: Omit<EditorConfig, 'savedAt'>): Promise<EditorConfigMeta>
  listEditorConfigs(): Promise<EditorConfigMeta[]>
  loadEditorConfig(id: string): Promise<EditorConfig>
  deleteEditorConfig(id: string): Promise<void>
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
  cancelExport(): Promise<void>
  onRenderProgress(cb: (e: RenderProgressEvent) => void): Unsubscribe
  // batch (one line = one clip; no project is persisted)
  batchRender(req: BatchRunRequest): Promise<BatchRunSummary>
  cancelBatch(jobId?: string): Promise<void>
  onBatchProgress(cb: (e: BatchRenderEvent) => void): Unsubscribe
  // downloader (Analyze IS a run with dryRun: true — one path, cancellable)
  /** Rejects when a run is already active (single-flight). */
  dlStart(req: DlRequest): Promise<{ jobId: string }>
  /** Aborts the active run (download or analyze) at the next chunk boundary. */
  dlCancel(): Promise<void>
  /** Newest 100 finished downloads from the state index. */
  dlList(): Promise<DlListEntry[]>
  /** Opens settings.downloads.dir in Explorer. */
  dlOpenFolder(): Promise<void>
  /** Folder picker for the settings download-dir field. */
  pickDirectory(): Promise<string | null>
  onDlProgress(cb: (e: DlProgressEvent) => void): Unsubscribe
  // shell
  revealInExplorer(path: string): Promise<void>
  openUserTemplatesFolder(): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>
  /** FFmpeg binary provenance + version for the Settings modal. */
  ffmpegInfo(): Promise<FfmpegInfo>
  /** app.getVersion() for the About section. */
  appVersion(): Promise<string>
  onMenuCommand(cb: (cmd: MenuCommand) => void): Unsubscribe
  /** Electron ≥32 removed File.path; webUtils.getPathForFile is the sandbox-safe replacement. */
  getPathForFile(file: File): string
}
