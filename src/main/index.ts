import { app, BrowserWindow } from 'electron'
import { registerMediaScheme, registerMediaProtocol } from './protocol/media'
import { registerIpcHandlers } from './ipc'
import { buildAppMenu } from './menu'
import { sweepStaleRenderTemp } from './sweep'
import { createMainWindow } from './windows/main-window'

// Dev-only: enable remote debugging for the verification harness (CDP).
if (process.env.SHORTZ_REMOTE_DEBUGGING && !app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.SHORTZ_REMOTE_DEBUGGING)
}

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
    void sweepStaleRenderTemp()
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
