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
  homeBatch: 'Batch',

  // Editor — top bar
  back: 'Back',
  export: 'Export',
  exportDisabledEmptyHook: 'Type a hook first',
  exportDisabledTooLong: 'Hook text does not fit — shorten it',
  exportDisabledNoVideo: 'Load a video first',
  exportDisabledResolving: 'Preparing the layout…',
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
  previewLimited: 'Video-only preview',

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

  // Editor — named configurations (fixed folder, no dialogs)
  configTitle: 'CONFIGURATION',
  configNameLabel: 'Name',
  configNamePlaceholder: 'Name this setup (e.g. squirrel reel)',
  saveConfig: 'Save config',
  saveConfigTitle: (name: string) =>
    name.trim().length === 0
      ? 'Type a name first'
      : `Save template, texts, knobs, trim and audio as "${name.trim()}" (same name updates it)`,
  configPickLabel: 'Saved configs',
  configEmptyOption: 'No saved configs yet',
  loadConfig: 'Load config',
  loadConfigTitle: 'Apply the selected configuration to this project',
  deleteConfig: 'Delete',
  deleteConfigTitle: 'Delete the selected configuration',
  configDeleteConfirm: (name: string) => `Delete saved config "${name}"?`,
  configHint: 'Template, texts, knobs, trim and audio — named setups, loadable into any project.',
  configSavedToast: (name: string) => `Configuration "${name}" saved`,
  configLoadedToast: (name: string) => `Configuration "${name}" loaded`,
  configDeletedToast: (name: string) => `Configuration "${name}" deleted`,
  errSaveConfig: 'Could not save the configuration',
  errLoadConfig: 'Could not load the configuration',
  errDeleteConfig: 'Could not delete the configuration',
  errConfigName: 'Type a name for the configuration first',

  // Batch — screen 4 (one line = one clip)
  batch: 'Batch',
  batchTitle: 'BATCH EDIT',
  batchBack: '← Back',
  batchIntro:
    'One line per video: the file location, then • then the hook text. Paste as many lines as you want — they render one after another.',
  batchFormatExample: 'C:\\Users\\user\\Videos\\ShortZ\\tupai.mp4•TUPAI YG LUCU',
  batchInputLabel: 'Videos and hooks',
  batchInputPlaceholder:
    'C:\\Users\\user\\Videos\\ShortZ\\tupai.mp4•TUPAI YG LUCU\nC:\\Users\\user\\Videos\\ShortZ\\kucing.mp4•KUCING YG MALAS',
  batchLinesSummary: (ok: number, total: number) => `${ok} of ${total} lines ready`,
  batchMissingHooks: (n: number) => `${n} line${n === 1 ? '' : 's'} without a hook`,
  batchProblemLine: (n: number) => `line ${n}`,
  batchProblemMissingPath: 'No file location before •',
  batchProblemExtension: (ext: string) => `Not a video file (${ext})`,
  batchProblemDuplicate: (line: string) => `Same file as ${line}`,
  batchProblemNoSeparator: 'No • separator — the hook is empty',
  batchProblemEmptyHook: 'No hook text after •',
  batchConfigTitle: 'CONFIGURATION',
  batchConfigLabel: 'Saved config',
  batchConfigNone: 'No saved configs — save one in the editor first',
  batchConfigHint: 'Template, knobs, trim and audio come from this config. Each line only supplies its own file and hook.',
  batchConfigReload: 'Reload',
  batchConfigReloadTitle: 'Re-read the saved configs from disk',
  batchTrimToggle: 'Apply the config\u2019s trim range',
  batchTrimHint: 'Off = render each clip in full',
  batchOutputLabel: 'Output folder',
  batchOutputHint: 'From Settings — change it there',
  batchStart: 'Render batch',
  batchStartTitle: (n: number) => `Render ${n} clip${n === 1 ? '' : 's'}`,
  batchStartDisabled: 'Fix the problems above first',
  batchCancel: 'Cancel',
  batchCancelHint: 'Stop the running clip and skip the rest',
  batchQueueTitle: 'QUEUE',
  batchQueueEmpty: 'Paste lines above to build the queue.',
  batchStatusPending: 'waiting',
  batchStatusProbing: 'probing',
  batchStatusRendering: 'rendering',
  batchStatusDone: 'done',
  batchStatusError: 'failed',
  batchStatusSkipped: 'skipped',
  batchRevealOutput: 'Open folder',
  batchFinishedToast: (n: number) => `Batch complete — ${n} clip${n === 1 ? '' : 's'} exported`,
  batchFinishedWithErrors: (ok: number, failed: number) => `Batch finished — ${ok} exported, ${failed} failed`,
  batchCancelledToast: 'Batch cancelled',
  batchEmptyError: 'Add at least one line to the batch',
  errBatchRender: 'Batch render failed',
  batchProgressOf: (done: number, total: number) => `${done} / ${total}`,

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
