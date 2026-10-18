import { app, dialog, Menu } from 'electron'
import { sendMenuCommand } from './ipc'

/** Native menu with About/Settings placeholders (roadmap M0). */
export function buildAppMenu(): void {
  const isDev = !app.isPackaged

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        {
          label: 'New Project…',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuCommand('new-project')
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuCommand('open-settings')
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools', visible: isDev },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About ShortZ',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'About ShortZ',
              message: 'ShortZ — fast local TikTok video editor.',
              detail: [
                'Templates, not timelines: drop a clip, pick a template, type a hook, export.',
                '',
                `Version ${app.getVersion()} (dev)`,
                'Electron + React + FFmpeg. Fully offline, no accounts, no telemetry.'
              ].join('\n')
            })
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
