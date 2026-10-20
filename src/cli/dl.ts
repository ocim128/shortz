/**
 * `shortz dl` — the headless downloader (`pnpm cli dl ...`).
 *
 * Grammar (D-A19): links come from positional arguments, files, stdin or `--id`;
 * the command is a thin shell around ONE `runDl` call, so what the CLI prints and
 * what the Electron surface shows come from the same events. Exit codes:
 * 0 all good, 1 any failed/partial item, 2 usage error, 130 cancelled.
 */

import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseRunInput } from '../shared/downloader/parse-run-input'
import { canonicalUrl } from '../shared/downloader/urls'
import { dlErrorMessage, dlSkipText } from '../shared/downloader/copy'
import type { DlInput, DlItemEvent, DlQuality, DlRunSummary } from '../shared/downloader/types'
import { runDl, type DlRunOptions } from '../core/downloader/orchestrator'
import { DEFAULT_FILENAME_TEMPLATE } from '../shared/downloader/naming'

const USAGE = `ShortZ downloader CLI

Usage:
  shortz dl [<link|file>...] [options]

Input:
  <link|file>            x.com / twitter.com status links, t.co short links,
                         or a file containing one link per line
      --file <path>      Read links from a file ("-" reads stdin)
      --id <id>          Download one tweet id (repeatable)
      --retry-failed     Re-queue the post(s) the last run left unfinished

Output:
      --out <dir>        Output folder (default: ~/Videos/ShortZ/Downloads)
      --data <dir>       Data folder for state.json + poster cache
                         (default: %APPDATA%/shortz)
      --layout <kind>    by-author | by-date | flat (default: by-author)
      --template <t>     File name template: {id}{date}{author}{index}{slug}
                         (default: {id})
      --no-sidecars      Do not write <file>.mp4.meta.json

Behaviour:
      --dry-run          Analyze only: resolve, select, plan. Writes nothing.
      --force            Re-download even when the post is already complete
      --retry-failed     (see Input)
      --quality <q>      best | worst | max:<height> (default: best)
      --fallback <mode>  off | fxtwitter | auto (default: auto)
      --concurrency <n>  Parallel downloads, 1..3 (default: 3)
      --json             Emit run events as NDJSON on stdout
  -h, --help             Show this help

Exit codes: 0 success, 1 failed items, 2 usage error, 130 cancelled.
`

class UsageError extends Error {}

interface DlCliOptions {
  linkArgs: string[]
  files: string[]
  ids: string[]
  out: string
  data: string
  layout: DlRunOptions['layout']
  template: string
  sidecars: boolean
  dryRun: boolean
  force: boolean
  retryFailed: boolean
  quality: DlQuality
  fallback: DlRunOptions['fallback']
  concurrency: number
  json: boolean
}

export function defaultDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'shortz')
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
  return path.join(configHome, 'shortz')
}

export function defaultOutputDir(): string {
  return path.join(os.homedir(), 'Videos', 'ShortZ', 'Downloads')
}

function parseQuality(value: string): DlQuality {
  if (value === 'best' || value === 'worst') return value
  const match = /^max:(\d{2,4})$/.exec(value)
  if (match === null) throw new UsageError('--quality must be best, worst or max:<height>')
  const height = Number.parseInt(match[1] as string, 10)
  if (!Number.isFinite(height) || height < 144)
    throw new UsageError('--quality height is too small')
  return { maxHeight: height }
}

export function parseDlArgs(argv: string[]): DlCliOptions {
  const options: DlCliOptions = {
    linkArgs: [],
    files: [],
    ids: [],
    out: defaultOutputDir(),
    data: defaultDataDir(),
    layout: 'by-author',
    template: DEFAULT_FILENAME_TEMPLATE,
    sidecars: true,
    dryRun: false,
    force: false,
    retryFailed: false,
    quality: 'best',
    fallback: 'auto',
    concurrency: 3,
    json: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    const next = (): string => {
      const value = argv[index + 1]
      if (value === undefined) throw new UsageError(`Missing value for ${arg}`)
      index += 1
      return value
    }
    switch (arg) {
      case '--file':
        options.files.push(next())
        break
      case '--id':
        options.ids.push(next())
        break
      case '--out':
        options.out = path.resolve(next())
        break
      case '--data':
        options.data = path.resolve(next())
        break
      case '--layout': {
        const layout = next()
        if (layout !== 'by-author' && layout !== 'by-date' && layout !== 'flat') {
          throw new UsageError('--layout must be by-author, by-date or flat')
        }
        options.layout = layout
        break
      }
      case '--template':
        options.template = next()
        break
      case '--no-sidecars':
        options.sidecars = false
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--force':
        options.force = true
        break
      case '--retry-failed':
        options.retryFailed = true
        break
      case '--quality':
        options.quality = parseQuality(next())
        break
      case '--fallback': {
        const fallback = next()
        if (fallback !== 'off' && fallback !== 'fxtwitter' && fallback !== 'auto') {
          throw new UsageError('--fallback must be off, fxtwitter or auto')
        }
        options.fallback = fallback
        break
      }
      case '--concurrency': {
        const concurrency = Number.parseInt(next(), 10)
        if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 3) {
          throw new UsageError('--concurrency must be 1..3')
        }
        options.concurrency = concurrency
        break
      }
      case '--json':
        options.json = true
        break
      default:
        if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}`)
        options.linkArgs.push(arg)
        break
    }
  }

  if (
    !options.retryFailed &&
    options.linkArgs.length === 0 &&
    options.files.length === 0 &&
    options.ids.length === 0
  ) {
    throw new UsageError('No links given (pass links, --file, or --id)')
  }
  return options
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** Assemble the run's text, then let the shared parser own keys and line numbers. */
async function collectText(options: DlCliOptions): Promise<string> {
  const blocks: string[] = []

  for (const arg of options.linkArgs) {
    // "a file containing one link per line" — a positional that exists is a file.
    if (existsSync(arg) && !/^https?:/i.test(arg)) {
      blocks.push(await fs.readFile(arg, 'utf8'))
    } else {
      blocks.push(arg)
    }
  }
  for (const file of options.files) {
    blocks.push(file === '-' ? await readStdin() : await fs.readFile(path.resolve(file), 'utf8'))
  }
  for (const id of options.ids) {
    if (!/^\d{2,19}$/.test(id)) throw new UsageError(`--id expects a numeric id, got "${id}"`)
    blocks.push(canonicalUrl(id, null))
  }
  return blocks.join('\n')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

/** "1280x720 · 2176 kbps · video/mp4" — the chosen variant, minus its query. */
function describeChosen(item: DlItemEvent['item']): string[] {
  const chosen = item.chosen ?? []
  return chosen.map((one) => {
    const parts: string[] = []
    if (one.width !== null && one.height !== null) parts.push(`${one.width}x${one.height}`)
    if (one.bitrate !== null && one.bitrate > 0)
      parts.push(`${Math.round(one.bitrate / 1000)} kbps`)
    if (one.bitrate === null || one.bitrate <= 0) parts.push('bitrate unknown')
    if (one.contentType !== null) parts.push(one.contentType)
    const at = one.url.indexOf('?')
    const url = at === -1 ? one.url : one.url.slice(0, at)
    return `#${one.index} ${parts.join(' · ')} · ${url}`
  })
}

export async function runDlCommand(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
    process.stdout.write(USAGE)
    return argv.length === 0 ? 2 : 0
  }

  let options: DlCliOptions
  try {
    options = parseDlArgs(argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`)
    return 2
  }

  const controller = new AbortController()
  let interrupts = 0
  const onInterrupt = (): void => {
    interrupts += 1
    if (interrupts === 1) {
      process.stderr.write('\n[dl] cancelling (press Ctrl+C again to force)\n')
      controller.abort()
      return
    }
    process.exit(130)
  }
  process.on('SIGINT', onInterrupt)

  const verbose = options.json !== true && process.stderr.isTTY === true

  try {
    const text = await collectText(options)
    const lines = parseRunInput(text)
    const inputs: DlInput[] = lines.map((line) => ({
      key: line.key,
      lineNumber: line.lineNumber,
      text: line.text
    }))

    if (inputs.length === 0 && !options.retryFailed) {
      process.stderr.write('No links found in the input.\n')
      return 2
    }

    const jobId = `cli-${Date.now().toString(36)}`
    process.stderr.write(
      `[dl] ${inputs.length} line(s) -> ${options.out}${options.dryRun ? ' (dry run)' : ''}\n`
    )

    const summary: DlRunSummary = await runDl(
      {
        inputs,
        ...(options.retryFailed ? { retryFailed: true as const } : {}),
        quality: options.quality,
        outputDir: options.out,
        ...(options.force ? { force: true } : {}),
        ...(options.dryRun ? { dryRun: true } : {})
      },
      {
        jobId,
        dataDir: options.data,
        signal: controller.signal,
        options: {
          outputDir: options.out,
          layout: options.layout,
          filenameTemplate: options.template,
          quality: options.quality,
          resolveConcurrency: 4,
          downloadConcurrency: options.concurrency,
          fallback: options.fallback,
          writeSidecars: options.sidecars,
          force: options.force,
          dryRun: options.dryRun,
          retryFailed: options.retryFailed
        },
        onEvent: (event) => {
          if (options.json) {
            process.stdout.write(`${JSON.stringify(event)}\n`)
            return
          }
          if (event.kind === 'media-progress') {
            if (!verbose) return
            const total = event.total === null ? '?' : formatBytes(event.total)
            process.stderr.write(
              `\r[dl] ${event.key} #${event.mediaIndex} ${formatBytes(event.bytes)} / ${total}   `
            )
            return
          }
          if (event.kind === 'run-done') return
          const item = event.item
          const label = `${event.lineNumber}.`
          if (item.status === 'planned') {
            process.stdout.write(`${label} planned ${item.tweetId}\n`)
            if (item.author !== undefined) process.stdout.write(`     @${item.author}\n`)
            if (item.caption !== undefined && item.caption.length > 0) {
              process.stdout.write(`     ${item.caption.replace(/\s+/g, ' ').slice(0, 120)}\n`)
            }
            for (const line of describeChosen(item)) process.stdout.write(`     ${line}\n`)
            for (const planned of item.plannedPaths ?? []) {
              process.stdout.write(`     -> ${planned}\n`)
            }
            return
          }
          if (item.status === 'skipped') {
            process.stdout.write(
              `${label} skipped (${dlSkipText(item.skipReason ?? 'duplicate')})\n`
            )
            return
          }
          if (item.status === 'failed') {
            process.stderr.write(
              `${label} failed${item.tweetId === '' ? '' : ` ${item.tweetId}`}: ${dlErrorMessage(
                item.errorCode ?? 'UNEXPECTED'
              )}${item.errorDetail === undefined ? '' : ` [${item.errorDetail}]`}\n`
            )
            return
          }
          if (item.status === 'ok' || item.status === 'partial') {
            const files = item.files ?? []
            const sizes = item.media ?? []
            const total = sizes.reduce((sum, media) => sum + media.bytes, 0)
            process.stdout.write(
              `${label} ${item.status} ${item.tweetId} — ${files.length} file(s)${
                total > 0 ? `, ${formatBytes(total)}` : ''
              }\n`
            )
            if (item.status === 'partial' && item.errorCode !== undefined) {
              process.stderr.write(`     [partial] ${dlErrorMessage(item.errorCode)}\n`)
            }
            return
          }
          if (item.status === 'cancelled') {
            process.stderr.write(`${label} cancelled\n`)
          }
        }
      }
    )

    if (process.stderr.isTTY === true) process.stderr.write('\n')
    const summaryLine =
      `Done: ${summary.total} line(s) — ${summary.ok} ok, ${summary.skipped} skipped, ` +
      `${summary.partial} partial, ${summary.failed} failed${
        summary.cancelled ? ', cancelled' : ''
      }\n`
    // In --json mode stdout is pure NDJSON, so the human summary goes to stderr.
    if (options.json) process.stderr.write(summaryLine)
    else process.stdout.write(summaryLine)

    if (summary.cancelled) return 130
    if (summary.failed > 0) return 1
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[dl] error: ${message}\n`)
    return 1
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
}

export { USAGE as DL_USAGE }
