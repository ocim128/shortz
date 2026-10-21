import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, dialog, shell } from 'electron'
import { logError, logInfo, setLogSink } from '../core/log'
import { dataDir } from './data'

/**
 * Persistent main-process log (finding: packaged builds print diagnostics to a
 * console that does not exist). Append-only, size-capped: main.log rotates to
 * main.old.log past the cap so the data dir never grows unbounded.
 */

const MAX_LOG_BYTES = 2 * 1024 * 1024

export function logsDir(): string {
  return path.join(dataDir(), 'logs')
}

export function mainLogPath(): string {
  return path.join(logsDir(), 'main.log')
}

// Serialize appends so concurrent warnings never interleave inside one line.
let writeChain: Promise<void> = Promise.resolve()

/** Rotate at most every N lines: the size cap must hold in a long session, not
 * only across restarts, but a stat per log line would be wasteful. */
const SIZE_CHECK_EVERY = 256
let linesSinceSizeCheck = 0

async function rotateIfOversized(): Promise<void> {
  linesSinceSizeCheck += 1
  if (linesSinceSizeCheck < SIZE_CHECK_EVERY) return
  linesSinceSizeCheck = 0
  const stat = await fsp.stat(mainLogPath()).catch(() => null)
  if (stat === null || stat.size <= MAX_LOG_BYTES) return
  await fsp.rename(mainLogPath(), path.join(logsDir(), 'main.old.log')).catch(() => undefined)
}

function appendLine(line: string): void {
  writeChain = writeChain
    .then(() => fsp.appendFile(mainLogPath(), `${line}\n`, 'utf8'))
    .then(rotateIfOversized)
    .catch(() => {
      /* a broken sink must never take the app down */
    })
}

/** Install the file sink (with rotation). Call once, as early as possible. */
export async function initFileLogger(): Promise<void> {
  try {
    await fsp.mkdir(logsDir(), { recursive: true })
    const stat = await fsp.stat(mainLogPath()).catch(() => null)
    if (stat && stat.size > MAX_LOG_BYTES) {
      await fsp
        .rename(mainLogPath(), path.join(logsDir(), 'main.old.log'))
        .catch(() => undefined)
    }
    setLogSink(appendLine)
    logInfo(`[shortz] log started (app ${app.getVersion()}, packaged=${String(app.isPackaged)})`)
  } catch {
    // Logging must never break startup — console-only is an acceptable floor.
  }
}

let fatalDialogShown = false

/**
 * Last-resort handler for uncaughtException/unhandledRejection: persist the
 * error, then offer the log folder before quitting. A field crash must leave
 * an artifact, not silence.
 */
export async function logFatal(kind: string, error: unknown): Promise<void> {
  logError(kind, error)
  if (fatalDialogShown) {
    // A cascade during shutdown — don't stack dialogs, just quit.
    app.quit()
    return
  }
  fatalDialogShown = true
  try {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'ShortZ hit an unexpected error',
      message: `${kind}: ${error instanceof Error ? error.message : String(error)}`,
      detail: 'Details were written to the log file in the ShortZ data folder.',
      buttons: ['Open log folder', 'Quit'],
      defaultId: 1,
      noLink: true
    })
    if (response === 0) await shell.openPath(logsDir())
  } catch {
    // No window available — the log line above is all we can leave behind.
  }
  app.quit()
}
