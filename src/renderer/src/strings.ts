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
  homeDuplicateMock: 'Mock project — source not on disk, cannot duplicate yet',
  homeRevealMissing: 'Source missing — re-link the project first',

  // Editor — top bar
  back: 'Back',
  export: 'Export',
  exportPendingTooltip: 'Engine pending — export wiring arrives with the render core',
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

  // Editor — field panel
  templateSettingsTitle: 'TEMPLATE SETTINGS',
  clipTitle: 'CLIP',
  linesCount: (n: number, max: number) => `${n} / ${max} lines`,
  charsCount: (n: number, max: number) => `${n} / ${max} chars`,
  textTooLong: (maxLines: number, minPx: number) =>
    `Too long for ${maxLines} lines even at ${minPx}px — shorten`,
  audioKeep: 'keep',
  audioMute: 'mute',
  trimStart: 'Trim start (s)',
  trimEnd: 'Trim end (s)',
  resetTrim: 'Reset trim',

  // Render bar
  enginePendingBar: 'Render engine pending — export will be wired when the core lands',

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
  ffmpegTest: 'Test',
  ffmpegPending: 'engine pending',
  storageTemplates: 'User templates folder',
  storageOpen: 'Open',
  storageProbeCache: 'Probe cache',
  storageClear: 'Clear',
  aboutVersion: (v: string) => `Version ${v}`,
  aboutLicenses: 'Licenses: Electron · FFmpeg (GPL) · Inter & Poppins (SIL OFL)',

  // Toasts
  savedToast: 'Project saved',
  enginePendingToast: 'Engine pending — export is not wired yet',
  mockOnlyToast: 'Mocked action — wired at engine integration',

  // Errors
  errCreateProject: 'Could not create the project',
  errMediaUrl: 'Could not open the video',
  errRelink: 'Re-link failed'
} as const
