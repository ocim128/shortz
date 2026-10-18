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
  saveEditorConfig: 'shortz:saveEditorConfig',
  listEditorConfigs: 'shortz:listEditorConfigs',
  loadEditorConfig: 'shortz:loadEditorConfig',
  deleteEditorConfig: 'shortz:deleteEditorConfig',
  pickFile: 'shortz:pickFile',
  getMediaUrl: 'shortz:getMediaUrl',
  getThumbUrl: 'shortz:getThumbUrl',
  getFontBuffer: 'shortz:getFontBuffer',
  listTemplates: 'shortz:listTemplates',
  exportProject: 'shortz:exportProject',
  cancelExport: 'shortz:cancelExport',
  renderProgress: 'shortz:render:progress',
  batchRender: 'shortz:batchRender',
  cancelBatch: 'shortz:cancelBatch',
  batchProgress: 'shortz:batch:progress',
  revealInExplorer: 'shortz:revealInExplorer',
  openUserTemplatesFolder: 'shortz:openUserTemplatesFolder',
  getSettings: 'shortz:getSettings',
  saveSettings: 'shortz:saveSettings',
  ffmpegInfo: 'shortz:ffmpegInfo',
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
  // editor configs
  saveEditorConfig: (c) => ipcRenderer.invoke(CHANNEL.saveEditorConfig, c),
  listEditorConfigs: () => ipcRenderer.invoke(CHANNEL.listEditorConfigs),
  loadEditorConfig: (id) => ipcRenderer.invoke(CHANNEL.loadEditorConfig, id),
  deleteEditorConfig: (id) => ipcRenderer.invoke(CHANNEL.deleteEditorConfig, id),
  // media
  pickFile: () => ipcRenderer.invoke(CHANNEL.pickFile),
  getMediaUrl: (sourcePath) => ipcRenderer.invoke(CHANNEL.getMediaUrl, sourcePath),
  getThumbUrl: (id) => ipcRenderer.invoke(CHANNEL.getThumbUrl, id),
  getFontBuffer: (key) => ipcRenderer.invoke(CHANNEL.getFontBuffer, key),
  // templates
  listTemplates: () => ipcRenderer.invoke(CHANNEL.listTemplates),
  // render
  exportProject: (p, opts) => ipcRenderer.invoke(CHANNEL.exportProject, p, opts),
  cancelExport: () => ipcRenderer.invoke(CHANNEL.cancelExport),
  onRenderProgress: (cb) => subscribe(CHANNEL.renderProgress, cb),
  // batch
  batchRender: (req) => ipcRenderer.invoke(CHANNEL.batchRender, req),
  cancelBatch: (jobId) => ipcRenderer.invoke(CHANNEL.cancelBatch, jobId),
  onBatchProgress: (cb) => subscribe(CHANNEL.batchProgress, cb),
  // shell
  revealInExplorer: (p) => ipcRenderer.invoke(CHANNEL.revealInExplorer, p),
  openUserTemplatesFolder: () => ipcRenderer.invoke(CHANNEL.openUserTemplatesFolder),
  getSettings: () => ipcRenderer.invoke(CHANNEL.getSettings),
  saveSettings: (s) => ipcRenderer.invoke(CHANNEL.saveSettings, s),
  ffmpegInfo: () => ipcRenderer.invoke(CHANNEL.ffmpegInfo),
  appVersion: () => ipcRenderer.invoke(CHANNEL.appVersion),
  // UI shell
  onMenuCommand: (cb) => subscribe(CHANNEL.menuCommand, cb),
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('shortz', api)
