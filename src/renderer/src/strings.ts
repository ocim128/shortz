/**
 * Every user-visible string in the renderer (docs/technical/ui-spec.md
 * §accessibility & i18n — one file from the start).
 */
export const S = {
  appName: 'ShortZ',

  // Home
  homeDropTitle: 'Drop a video here',
  homeDropHint: 'or click to browse',
  homeRecent: 'Recent projects',
  homeNoProjects: 'No projects yet — drop a clip to start.',
  homeRelink: 'Re-link',
  homeSettings: 'Settings',
  homeRelinkPrompt: 'Source file is missing. Pick the new location.',
  homeRelinked: 'Source re-linked',
  homeDeleteConfirm: 'Delete this project? Exports on disk are kept.',
  homeDuplicate: 'Duplicate',
  homeOpenLocation: 'Open file location',
  homeDelete: 'Delete',
  homeDuplicated: 'Duplicated as a new project',
  homeRevealMissing: 'Source missing — re-link the project first',
  homeThumbFailed: 'Thumbnail unavailable',

  // Editor — top bar
  back: 'Back',
  export: 'Export',
  exportDisabledEmptyHook: 'Type a hook first',
  exportDisabledTooLong: 'Hook text does not fit — shorten it',
  exportDisabledNoVideo: 'Load a video first',
  exportDisabledMissing: 'Source file missing — re-link first',
  exportHint: 'Ctrl+E',
  unsavedDot: 'Unsaved changes',

  // Editor — template picker
  templatesTitle: 'TEMPLATES',
  badgeBuiltin: 'built-in',
  badgeUser: 'user',
  addUserTemplate: 'user',
  addUserTemplateTitle: 'Open the user-templates folder',
  invalidTemplate: 'Invalid template',

  // Editor — preview
  safeZones: 'Safe zones',
  play: 'Play',
  pause: 'Pause',
  noVideoLoaded: 'No video',
  layoutErrorTitle: 'Preview unavailable',

  // Editor — field panel
  templateSettingsTitle: 'TEMPLATE SETTINGS',
  clipTitle: 'CLIP',
  linesCount: (n: number, max: number) => `${n} / ${max} lines`,
  charsCount: (n: number, max: number) => `${n} / ${max} chars`,
  textTooLong: (maxLines: number, minPx: number) =>
    `Too long for ${maxLines} lines even at ${minPx}px — shorten`,
  textShrunk: (minPx: number) => `Shrunk to the ${minPx}px minimum to fit`,
  inputRequired: 'Required',
  audioKeep: 'keep',
  audioMute: 'mute',
  trimStart: 'Trim start (s)',
  trimEnd: 'Trim end (s)',
  resetTrim: 'Reset trim',

  // Render bar
  rendering: 'Rendering…',
  progressStage: (stage: string) => `Rendering… ${stage}`,
  cancelExport: 'Cancel',
  cancelExportHint: 'Kill ffmpeg immediately',
  exportErrorTitle: 'Render failed',
  exportErrorDismiss: 'Dismiss',
  eta: (s: number) => `eta ${s}s`,

  // Export toasts
  exportStartedToast: 'Export started',
  exportDoneToast: (path: string) => `Export complete — ${path}`,
  exportCancelled: 'Export cancelled',
  exportFailedToast: 'Export failed — see the bar for details',
  exportMissingSource: 'Source file missing — re-link first',

  // Relink banner
  relinkBanner: 'Source file moved or deleted.',
  relinkChoose: 'Choose file…',

  // Settings modal
  settingsTitle: 'Settings',
  settingsCancel: 'Cancel',
  settingsSave: 'Save',
  settingsSaved: 'Settings saved',
  secOutput: 'Output',
  secEncoder: 'Encoder',
  secFfmpeg: 'FFmpeg',
  secStorage: 'Storage',
  secAbout: 'About',
  outputDir: 'Default folder',
  filenamePattern: 'Filename pattern',
  encoderPreferred: 'Encoder',
  encoderCrf: 'Quality (CRF)',
  encoderFps: 'FPS',
  ffmpegSource: 'Binary source',
  ffmpegVersion: 'Version',
  ffmpegVersionValue: (v: string) => `${v}`,
  ffmpegTest: 'Test',
  ffmpegTestOk: (v: string) => `FFmpeg OK — ${v}`,
  ffmpegTestFail: 'FFmpeg test failed',
  ffmpegSourceName: (s: string) => (s === 'system' ? 'System PATH' : s === 'bundled' ? 'Bundled' : `Custom (${s})`),
  storageTemplates: 'User templates folder',
  storageOpen: 'Open',
  storageProbeCache: 'Probe cache',
  storageClear: 'Clear',
  storageCacheValue: (entries: number, size: string) => `${entries} entries · ${size}`,
  storageCacheCleared: 'Probe cache cleared',
  aboutVersion: (v: string) => `Version ${v}`,
  aboutLicenses: 'Licenses: Electron · FFmpeg (GPL) · Inter & Poppins (SIL OFL)',

  // Toasts
  savedToast: 'Project saved',

  // Errors
  errCreateProject: 'Could not create the project',
  errMediaUrl: 'Could not open the video',
  errRelink: 'Re-link failed'
} as const
