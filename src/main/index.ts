import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerMediaScheme, registerMediaProtocol } from './protocol/media'
import { registerIpcHandlers } from './ipc'
import { buildAppMenu } from './menu'
import { initFileLogger, logFatal } from './logger'
import { sweepStaleRenderTemp } from './sweep'
import { createMainWindow } from './windows/main-window'
import { logError } from '../core/log'

// Dev-only: enable remote debugging for the verification harness (CDP).
if (process.env.SHORTZ_REMOTE_DEBUGGING && !app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.SHORTZ_REMOTE_DEBUGGING)
}

/**
 * Portable mode (docs/technical/data-storage.md §"Folder layout"): when a
 * `portable.flag` file sits next to the exe, the data dir moves to `.\data\`
 * next to the exe instead of %APPDATA%\shortz. Must run before anything
 * touches userData — including the single-instance lock, which is keyed on it.
 *
 * PORTABLE_EXECUTABLE_DIR: the electron-builder "portable" target self-extracts
 * to a temp dir, so app.getPath('exe') points at the extraction — the flag and
 * data dir belong next to the ORIGINAL exe, which the target tells us via env.
 */
function applyPortableMode(): void {
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR ?? path.dirname(app.getPath('exe'))
  if (!fs.existsSync(path.join(exeDir, 'portable.flag'))) return
  const dataDir = path.join(exeDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  app.setPath('userData', dataDir)
  console.log(`[shortz] portable mode active — userData: ${dataDir}`)
}

applyPortableMode()

// Persistent, size-capped log + last-resort handlers — installed before
// anything that can fail. Packaged builds have no console; without this a
// field crash leaves no artifact behind.
process.on('uncaughtException', (error) => {
  void logFatal('uncaughtException', error)
})

// A rejected promise is not evidence that the process is unusable: killing the
// app (and the dialog) on every stray fire-and-forget rejection would take a
// running export or download down with it. Log it, keep going, and only treat
// a storm as fatal. Uncaught exceptions above stay fatal.
let rejectionCount = 0
process.on('unhandledRejection', (reason) => {
  rejectionCount += 1
  logError('unhandledRejection', reason)
  if (rejectionCount === 20) {
    void logFatal(
      'unhandledRejection storm',
      new Error(`${rejectionCount} unhandled rejections — something is retrying forever`)
    )
  }
})
void initFileLogger()

// Privileged scheme registration MUST happen before app ready.
registerMediaScheme()

// Single instance (docs/technical/data-storage.md §concurrency).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    registerMediaProtocol()
    registerIpcHandlers()
    buildAppMenu()
    // Crash-leftover temp dirs (older than 24h) — never blocks startup.
    sweepStaleRenderTemp().catch((error) => {
      logError('temp sweep', error)
    })
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
}

// Hard security floor: no in-app navigation away from the app origin
// (dev server in dev, file:// build in prod); window.open is denied in
// main-window.ts. Belt and suspenders for stray target=_blank links.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('http://localhost:') || url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
