import fs from 'node:fs'
import path from 'node:path'
import { app, shell, type BrowserWindow } from 'electron'
import { logError } from '../../core/log'

// Keep this in sync with electron-builder.yml so dev and installed windows
// use ShortZ's identity instead of the shared Electron identity.
export const TASKBAR_APP_ID = 'app.shortz.desktop'

export function configureTaskbar(win: BrowserWindow): void {
  if (process.platform !== 'win32' || app.isPackaged) return

  const root = app.getAppPath()
  const target =
    process.env.ComSpec ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const args = `/d /s /c ""${path.join(root, 'run.bat')}""`
  const icon = path.join(root, 'resources', 'icons', 'icon.ico')

  // Pinning a dev window otherwise saves only electron.exe, losing both the
  // app argument and the Vite server. Relaunch through the existing dev launcher.
  win.setAppDetails({
    appId: TASKBAR_APP_ID,
    appIconPath: icon,
    appIconIndex: 0,
    relaunchCommand: `"${target}" ${args}`,
    relaunchDisplayName: 'ShortZ'
  })

  // Migrate pins made before the window supplied relaunch metadata. Only touch
  // bare Electron shortcuts pointing to THIS repo's executable.
  const taskbarDir = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Internet Explorer',
    'Quick Launch',
    'User Pinned',
    'TaskBar'
  )
  if (!fs.existsSync(taskbarDir)) return
  try {
    for (const name of fs.readdirSync(taskbarDir)) {
      if (path.extname(name).toLowerCase() !== '.lnk') continue
      const shortcutPath = path.join(taskbarDir, name)
      try {
        const shortcut = shell.readShortcutLink(shortcutPath)
        if (path.resolve(shortcut.target).toLowerCase() !== process.execPath.toLowerCase()) continue
        if (shortcut.args?.trim()) continue
        if (
          !shell.writeShortcutLink(shortcutPath, 'update', {
            target,
            args,
            cwd: root,
            description: 'ShortZ',
            appUserModelId: TASKBAR_APP_ID,
            icon,
            iconIndex: 0
          })
        ) {
          throw new Error(`Could not update ${shortcutPath}`)
        }
      } catch (error) {
        logError('taskbar shortcut', error)
      }
    }
  } catch (error) {
    logError('taskbar shortcuts', error)
  }
}
