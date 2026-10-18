import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import fss from 'node:fs'
import type {
  ExportOptions,
  ExportResult,
  FontKey,
  Project,
  Settings,
  TemplateMeta
} from '../preload/api'
import { getMediaUrlForFile } from './protocol/media'
import { mockSettings, mockTemplates, nextMockId, projects, setMockSettings, toMeta, touch } from './mock/data'

/**
 * Typed IPC handlers (docs/technical/project-structure.md §"IPC contract").
 * Everything engine-shaped is a documented-shape MOCK until Agent A's
 * src/core exists — the full list lives in tmp/NOTES-B.md as the
 * integration checklist. Shell/media methods are real.
 */

const FONT_FILES: Record<FontKey, string> = {
  'inter-regular': 'Inter-Regular.ttf',
  'inter-semibold': 'Inter-SemiBold.ttf',
  'inter-extrabold': 'Inter-ExtraBold.ttf',
  'poppins-semibold': 'Poppins-SemiBold.ttf'
}

function dataDir(): string {
  return app.getPath('userData')
}

function fontsDir(): string {
  // docs/technical/project-structure.md §packaging notes — main computes,
  // core consumes. Fonts are asarUnpacked when packaged.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'fonts')
    : path.join(app.getAppPath(), 'resources', 'fonts')
}

function mainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  return wins[0] ?? null
}

function sendToRenderer(channel: string, payload: unknown): void {
  const win = mainWindow()
  if (win) win.webContents.send(channel, payload)
}

export function sendMenuCommand(cmd: 'new-project' | 'open-settings'): void {
  sendToRenderer('shortz:menu:command', cmd)
}

function handle<A extends unknown[]>(channel: string, fn: (...args: A) => Promise<unknown>): void {
  ipcMain.handle(channel, (_event, ...args: A) => fn(...args))
}

export function registerIpcHandlers(): void {
  // --- projects (MOCK persistence: in-memory Map) --------------------------

  handle('shortz:createProject', async (sourcePath: string) => {
    const abs = path.resolve(sourcePath)
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat || !stat.isFile()) throw new Error(`File not found: ${abs}`)
    // TODO(integration): run ffprobe here (A's src/core/ffmpeg/probe) and store
    // the snapshot; the renderer meanwhile derives duration/dims from <video>.
    const project: Project = {
      schemaVersion: 1,
      id: nextMockId(),
      name: path.basename(abs, path.extname(abs)),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: { path: abs, probe: null },
      templateId: 'hook-letterbox',
      values: { fields: { hook: '' }, knobs: {} },
      trim: { start: 0, end: 0 },
      audio: 'keep',
      exportHistory: []
    }
    projects.set(project.id, project)
    return project
  })

  handle('shortz:listProjects', async () =>
    [...projects.values()].map(toMeta).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  )

  handle('shortz:openProject', async (id: string) => {
    const p = projects.get(id)
    if (!p) throw new Error(`No such project: ${id}`)
    // Real existence check so the re-link banner shows for moved files.
    const st = await fsp.stat(p.source.path).catch(() => null)
    p.source.missing = !(st && st.isFile())
    return p
  })

  handle('shortz:saveProject', async (p: Project) => {
    projects.set(p.id, p)
    touch(p)
  })

  handle('shortz:deleteProject', async (id: string) => {
    projects.delete(id)
  })

  handle('shortz:relinkSource', async (id: string, newPath: string) => {
    const p = projects.get(id)
    if (!p) throw new Error(`No such project: ${id}`)
    const abs = path.resolve(newPath)
    const st = await fsp.stat(abs).catch(() => null)
    if (!st || !st.isFile()) throw new Error(`File not found: ${abs}`)
    p.source.path = abs
    p.source.missing = false
    // TODO(integration): re-run probe on relink (docs/02-architecture failure table).
    touch(p)
    return p
  })

  // --- media ----------------------------------------------------------------

  handle('shortz:pickFile', async () => {
    const win = mainWindow()
    const result = await dialog.showOpenDialog(win!, {
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

  handle('shortz:getFontBuffer', async (key: FontKey) => {
    const file = FONT_FILES[key]
    if (!file) throw new Error(`Unknown font key: ${key}`)
    const fontPath = path.join(fontsDir(), file)
    try {
      const buf = await fsp.readFile(fontPath)
      return new Uint8Array(buf)
    } catch {
      // Engine-pending period: fonts are Agent A's resources/fonts lane.
      // Return an empty buffer (font-loader skips it, CSS falls back to
      // system fonts) instead of a rejected promise that spams the console.
      // TODO(integration): throw again once fonts are guaranteed present.
      return new Uint8Array(0)
    }
  })

  // --- templates (MOCK: metas only; bodies live in renderer mock) -----------

  handle('shortz:listTemplates', async (): Promise<TemplateMeta[]> => mockTemplates)

  // --- render (MOCK — engine pending) ----------------------------------------

  handle('shortz:exportProject', async (_p: Project, _opts: ExportOptions): Promise<ExportResult> => {
    // The renderer keeps Export disabled with a "pending engine" tooltip, so
    // reaching this means wiring work, not a user action. Return the
    // documented shape with clearly-pending values.
    return {
      jobId: 'mock',
      path: '(engine pending)',
      durationSec: 0,
      sizeBytes: 0,
      encoder: 'libx264',
      crf: 18
    }
  })

  handle('shortz:cancelExport', async (_jobId: string) => {
    /* no mock job ever runs */
  })

  // --- shell ------------------------------------------------------------------

  handle('shortz:revealInExplorer', async (p: string) => {
    if (fss.existsSync(p)) {
      shell.showItemInFolder(p)
      return
    }
    // Fall back to the containing folder; surface a readable error when even
    // that is gone (missing-source mock projects) instead of failing silently.
    const dir = path.dirname(p)
    const err = await shell.openPath(dir)
    if (err) throw new Error(`Cannot open "${dir}": ${err}`)
  })

  handle('shortz:openUserTemplatesFolder', async () => {
    const dir = path.join(dataDir(), 'templates', 'user')
    await fsp.mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })

  handle('shortz:getSettings', async (): Promise<Settings> => mockSettings)

  handle('shortz:saveSettings', async (s: Settings): Promise<Settings> => setMockSettings(s))
}
