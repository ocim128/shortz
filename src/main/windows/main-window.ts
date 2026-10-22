import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { configureTaskbar } from './taskbar'

/**
 * Main window (roadmap M0: dark app window, 1280×800 min).
 * Security posture per docs/02-architecture.md: contextIsolation, no node
 * integration, sandboxed renderer — all FS/process access goes through the
 * typed preload bridge.
 */

// The dev server URL is injected by electron-vite at build/serve time.
const rendererUrl = process.env['ELECTRON_RENDERER_URL']

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    show: false,
    backgroundColor: '#0d0d0f', // --bg-0, avoids white flash
    title: 'ShortZ',
    icon: path.join(app.getAppPath(), 'resources', 'icons', 'icon.ico'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  configureTaskbar(win)

  win.once('ready-to-show', () => {
    win.show()
  })

  // Open any external navigation in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}
