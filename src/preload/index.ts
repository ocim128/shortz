import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ShortzApi } from './api'

/**
 * Typed hand-rolled bridge (docs/technical/project-structure.md §"IPC contract").
 * Runs in a sandboxed preload: only electron's contextBridge/ipcRenderer/webUtils
 * are available — no Node builtins, no filesystem.
 */

const CHANNEL = {
  createProject: 'shortz:createProject',
  listProjects: 'shortz:listProjects',
  openProject: 'shortz:openProject',
  saveProject: 'shortz:saveProject',
  deleteProject: 'shortz:deleteProject',
  relinkSource: 'shortz:relinkSource',
  pickFile: 'shortz:pickFile',
  getMediaUrl: 'shortz:getMediaUrl',
  getThumbUrl: 'shortz:getThumbUrl',
  getFontBuffer: 'shortz:getFontBuffer',
  listTemplates: 'shortz:listTemplates',
  exportProject: 'shortz:exportProject',
  cancelExport: 'shortz:cancelExport',
  renderProgress: 'shortz:render:progress',
  revealInExplorer: 'shortz:revealInExplorer',
  openUserTemplatesFolder: 'shortz:openUserTemplatesFolder',
  getSettings: 'shortz:getSettings',
  saveSettings: 'shortz:saveSettings',
  ffmpegInfo: 'shortz:ffmpegInfo',
  ffmpegTest: 'shortz:ffmpegTest',
  probeCacheInfo: 'shortz:probeCacheInfo',
  probeCacheClear: 'shortz:probeCacheClear',
  appVersion: 'shortz:appVersion',
  menuCommand: 'shortz:menu:command'
} as const

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: ShortzApi = {
  // projects
  createProject: (sourcePath) => ipcRenderer.invoke(CHANNEL.createProject, sourcePath),
  listProjects: () => ipcRenderer.invoke(CHANNEL.listProjects),
  openProject: (id) => ipcRenderer.invoke(CHANNEL.openProject, id),
  saveProject: (p) => ipcRenderer.invoke(CHANNEL.saveProject, p),
  deleteProject: (id) => ipcRenderer.invoke(CHANNEL.deleteProject, id),
  relinkSource: (id, newPath) => ipcRenderer.invoke(CHANNEL.relinkSource, id, newPath),
  // media
  pickFile: () => ipcRenderer.invoke(CHANNEL.pickFile),
  getMediaUrl: (sourcePath) => ipcRenderer.invoke(CHANNEL.getMediaUrl, sourcePath),
  getThumbUrl: (id) => ipcRenderer.invoke(CHANNEL.getThumbUrl, id),
  getFontBuffer: (key) => ipcRenderer.invoke(CHANNEL.getFontBuffer, key),
  // templates
  listTemplates: () => ipcRenderer.invoke(CHANNEL.listTemplates),
  // render
  exportProject: (p, opts) => ipcRenderer.invoke(CHANNEL.exportProject, p, opts),
  cancelExport: (jobId) => ipcRenderer.invoke(CHANNEL.cancelExport, jobId),
  onRenderProgress: (cb) => subscribe(CHANNEL.renderProgress, cb),
  // shell
  revealInExplorer: (p) => ipcRenderer.invoke(CHANNEL.revealInExplorer, p),
  openUserTemplatesFolder: () => ipcRenderer.invoke(CHANNEL.openUserTemplatesFolder),
  getSettings: () => ipcRenderer.invoke(CHANNEL.getSettings),
  saveSettings: (s) => ipcRenderer.invoke(CHANNEL.saveSettings, s),
  ffmpegInfo: () => ipcRenderer.invoke(CHANNEL.ffmpegInfo),
  ffmpegTest: () => ipcRenderer.invoke(CHANNEL.ffmpegTest),
  probeCacheInfo: () => ipcRenderer.invoke(CHANNEL.probeCacheInfo),
  probeCacheClear: () => ipcRenderer.invoke(CHANNEL.probeCacheClear),
  appVersion: () => ipcRenderer.invoke(CHANNEL.appVersion),
  // UI shell
  onMenuCommand: (cb) => subscribe(CHANNEL.menuCommand, cb),
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('shortz', api)
