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
  homeDownloader: 'Downloader',

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
  addUserTemplate: 'New template',
  addUserTemplateTitle: 'Open the user-templates folder and drop a template.json in it',
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
  audioLabel: 'Audio',
  audioKeep: 'Keep',
  audioMute: 'Mute',
  trimStart: 'Start (s)',
  trimEnd: 'End (s)',
  trimOff: 'off',
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
  batchBack: 'Back',
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
  batchConfigHint:
    'Template, knobs, trim and audio come from this config. Each line only supplies its own file and hook.',
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
  batchFinishedWithErrors: (ok: number, failed: number) =>
    `Batch finished — ${ok} exported, ${failed} failed`,
  batchCancelledToast: 'Batch cancelled',
  batchEmptyError: 'Add at least one line to the batch',
  errBatchRender: 'Batch render failed',
  batchProgressOf: (done: number, total: number) => `${done} / ${total}`,

  // Downloader — one textarea line = one X post (twitter-downloader)
  downloader: 'Downloader',
  dlTitle: 'X LINKS',
  dlBack: 'Back',
  dlIntro: "Paste X status links — one per line. '#' starts a comment.",
  dlPlaceholder:
    'https://x.com/someuser/status/1750123456789012352\nx.com/other/status/1750123456789012999\n# the funny squirrel one\nhttps://t.co/abcd1234',
  dlLinkSummary: (links: number, problems: number) =>
    `${links} link${links === 1 ? '' : 's'} · ${problems} problem${problems === 1 ? '' : 's'}`,
  dlProblemLine: (n: number) => `line ${n}`,
  dlProblemNoLink: 'No X post link on this line',
  dlProblemInvalidId: "That post id doesn't look right",
  dlProblemShortLink: 'Short link — will expand',
  dlProblemDuplicate: 'Same post as an earlier line',
  dlProblemMultipleLinks: 'More than one link — split this line',
  dlAnalyze: 'Analyze',
  dlAnalyzeHint:
    'Resolve the links and show author, caption and planned file names — writes nothing',
  dlDownload: 'Download',
  dlDownloadHint: 'Download every valid line (Ctrl+Enter)',
  dlDownloadDisabled: 'Paste at least one link first',
  dlRetryFailed: 'Retry failed',
  dlRetryHint: 'Re-enqueue the failed or incomplete posts from the state index',
  dlCancel: 'Cancel',
  dlCancelHint: 'Stop the run — partial .part files are kept for a retry',
  dlOpenFolder: 'Open folder',
  dlRunLabel: (id: string) => `RUN ${id}`,
  dlRunAnalyzing: (done: number, total: number) => `analyzing ${done}/${total}`,
  dlRunDownloading: (done: number, total: number) => `downloading ${done}/${total}`,
  dlRunRetrying: (done: number, total: number) => `retrying ${done}/${total}`,
  dlRunSummary: (s: {
    ok: number
    skipped: number
    partial: number
    failed: number
    cancelled: number
  }) => {
    const parts = [`${s.ok} done`]
    if (s.skipped > 0) parts.push(`${s.skipped} skipped`)
    if (s.partial > 0) parts.push(`${s.partial} partial`)
    if (s.failed > 0) parts.push(`${s.failed} failed`)
    if (s.cancelled > 0) parts.push(`${s.cancelled} cancelled`)
    return parts.join(' · ')
  },
  dlRunning: 'running',
  dlStatusQueued: 'queued',
  dlStatusResolving: 'resolving',
  dlStatusPlanned: 'ready',
  dlStatusSkipped: 'skipped',
  dlStatusDownloading: 'downloading',
  dlStatusOk: 'done',
  dlStatusPartial: 'partial',
  dlStatusFailed: 'failed',
  dlStatusCancelled: 'cancelled',
  dlRowLine: (n: number) => `line ${n}`,
  dlRowNewProject: 'New project',
  dlRowReveal: 'Reveal',
  dlRowCopyPath: 'Copy path',
  dlRowCopyUrl: 'Copy URL',
  dlRowMore: 'More actions',
  dlMediaPosition: (media: number, count: number) => (count > 1 ? `media ${media}/${count}` : ''),
  dlPercent: (pct: number) => `${pct}%`,
  dlEmptyTitle: 'Paste a few links to start',
  dlEmptyBody:
    'ShortZ resolves each post, downloads the best video and saves it in your folder. Nothing is uploaded and no account is needed.',
  dlLegal:
    'Download only content you have the right to use. ShortZ stores files locally and never uploads anything.',
  dlFallbackHint:
    'Not embeddable via Twitter syndication — enable the fxtwitter fallback in Settings to try harder.',
  dlFallbackSettings: 'Download settings',
  dlRecentTitle: 'RECENT DOWNLOADS',
  dlRecentEmpty: 'Nothing downloaded yet.',
  dlCopiedPath: 'File path copied',
  dlCopiedUrl: 'Link copied',
  dlNewProjectError: 'Could not create a project from that file',
  dlStartError: 'Could not start the download run',

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
  secDownloads: 'Downloads',
  downloadsHint:
    'Twitter/X links only. Files go to this folder; ShortZ keeps its index and poster cache in the app data folder.',
  downloadsDirLabel: 'Download folder',
  downloadsBrowse: 'Browse…',
  downloadsTemplateLabel: 'Filename template',
  downloadsTemplateHint: 'Variables: {id} · {date} · {author} · {index} · {slug}',
  downloadsExample: (name: string) => `Example: ${name}.mp4`,
  downloadsQualityLabel: 'Quality',
  downloadsQualityBest: 'Best available',
  downloadsQualityWorst: 'Smallest file',
  downloadsQualityMax: (height: number) => `Up to ${height}p`,
  downloadsResolveLabel: 'Resolve concurrency',
  downloadsDownloadLabel: 'Download concurrency',
  downloadsBeGentle:
    'Be gentle — X rate-limits aggressive batches. 4 resolves / 3 downloads is a good default.',
  downloadsFallbackLabel: 'Fallback resolver',
  downloadsFallbackOff: 'Off',
  downloadsFallbackFx: 'fxtwitter',
  downloadsFallbackAuto: 'yt-dlp sidecar (not available yet)',
  downloadsFallbackNote:
    'fxtwitter is a third-party service: enabling it sends the post link to api.fxtwitter.com.',
  downloadsSidecarsLabel: 'Write .meta.json sidecars',
  downloadsSidecarsHint:
    'One JSON file per download with the caption, author and origin — readable outside ShortZ.',
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
  ffmpegSourceName: (s: string) =>
    s === 'system' ? 'System PATH' : s === 'bundled' ? 'Bundled' : `Custom (${s})`,
  storageTemplates: 'User templates folder',
  storageOpen: 'Open',
  aboutVersion: (v: string) => `Version ${v}`,
  aboutLicenses: 'Licenses: Electron · FFmpeg (GPL) · Inter & Poppins (SIL OFL)',

  // Toasts
  savedToast: 'Project saved',
  toastDismiss: 'Dismiss notification',

  // Errors
  errCreateProject: 'Could not create the project',
  errMediaUrl: 'Could not open the video',
  errRelink: 'Re-link failed'
} as const
