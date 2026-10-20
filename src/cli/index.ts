import { existsSync } from 'node:fs'
import path from 'node:path'
import { runDlCommand } from './dl'
import { loadProjectDocument, ProjectFileError } from '../core/store/projects'
import { loadTemplateById } from '../core/store/templates'
import {
  defaultTmpRoot,
  renderProject,
  RenderCancelledError,
  RenderError,
  type OrchestratorProgress
} from '../core/render/orchestrator'
import { TemplateValidationError } from '../shared/template/validate'
import type { EncoderKind } from '../core/ffmpeg/argbuilder'

const USAGE = `ShortZ CLI (headless pipeline)

Usage:
  shortz render <project.json> [-o <out.mp4>] [options]
  shortz dl [<link|file>...] [options]      Twitter/X downloader (see: shortz dl --help)

Render options:
  -o, --output <file>     Output file (default: <name>_<yyyyMMdd>_<HHmm>.mp4 in cwd)
      --fps <n>           Output fps (default 30)
      --crf <n>           x264 CRF (default 18)
      --encoder <kind>    libx264 | h264_nvenc (default libx264)
      --audio <mode>      keep | mute (default: project setting)
      --resources <dir>   Directory containing fonts/ and templates/
      --tmp <dir>         Temp work root (default: %TEMP%/shortz)
      --cache <dir>       ffprobe cache dir (default: %TEMP%/shortz/cache/probes)
  -h, --help              Show this help

Exit codes: 0 success, 1 error, 130 cancelled.
`

interface CliOptions {
  command: string
  projectPath?: string
  output?: string
  fps?: number
  crf?: number
  encoder?: EncoderKind
  audio?: 'keep' | 'mute'
  resources?: string
  tmp?: string
  cache?: string
}

class CliError extends Error {}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { command: argv[0] ?? 'help' }
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string
    const next = (): string => {
      const value = rest[i + 1]
      if (value === undefined) throw new CliError(`Missing value for ${arg}`)
      i += 1
      return value
    }
    switch (arg) {
      case '-o':
      case '--output':
        options.output = next()
        break
      case '--fps': {
        const fps = Number(next())
        if (!Number.isFinite(fps) || fps <= 0) throw new CliError('--fps must be a positive number')
        options.fps = fps
        break
      }
      case '--crf': {
        const crf = Number(next())
        if (!Number.isFinite(crf) || crf < 0 || crf > 51)
          throw new CliError('--crf must be in [0, 51]')
        options.crf = crf
        break
      }
      case '--encoder': {
        const encoder = next()
        if (encoder !== 'libx264' && encoder !== 'h264_nvenc') {
          throw new CliError('--encoder must be libx264 or h264_nvenc')
        }
        options.encoder = encoder
        break
      }
      case '--audio': {
        const audio = next()
        if (audio !== 'keep' && audio !== 'mute') throw new CliError('--audio must be keep or mute')
        options.audio = audio
        break
      }
      case '--resources':
        options.resources = next()
        break
      case '--tmp':
        options.tmp = next()
        break
      case '--cache':
        options.cache = next()
        break
      case '-h':
      case '--help':
        options.command = 'help'
        break
      default:
        if (arg.startsWith('-')) throw new CliError(`Unknown option ${arg}`)
        if (options.projectPath === undefined) {
          options.projectPath = arg
        } else {
          throw new CliError(`Unexpected argument ${arg}`)
        }
    }
  }
  return options
}

function findResourcesDir(override?: string): string {
  const candidates: string[] = []
  if (override) candidates.push(path.resolve(override))
  if (process.env.SHORTZ_RESOURCES) candidates.push(path.resolve(process.env.SHORTZ_RESOURCES))
  try {
    candidates.push(path.resolve(__dirname, '..', '..', 'resources'))
  } catch {
    // __dirname unavailable (ESM) — fall through to cwd candidate
  }
  candidates.push(path.resolve(process.cwd(), 'resources'))
  for (const candidate of candidates) {
    if (
      existsSync(path.join(candidate, 'templates', 'hook-letterbox.json')) ||
      (existsSync(path.join(candidate, 'fonts')) && existsSync(path.join(candidate, 'templates')))
    ) {
      return candidate
    }
  }
  throw new CliError(
    `Could not locate the resources directory (fonts/ + templates/). Tried:\n  ${candidates.join('\n  ')}\nUse --resources <dir>.`
  )
}

function timestampSuffix(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80)
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} kB`
  return `${bytes} B`
}

function progressPrinter(): (progress: OrchestratorProgress) => void {
  let lastPct = -1
  const tty = process.stderr.isTTY === true
  return (progress: OrchestratorProgress): void => {
    const pct = Math.round(progress.pct)
    if (progress.stalled) {
      process.stderr.write(`\n[render] stalled (no progress output for 60s)\n`)
      return
    }
    if (pct === lastPct) return
    lastPct = pct
    if (tty) {
      process.stderr.write(`\r[render] ${progress.stage} ${pct}%`)
    } else if (pct % 10 === 0 || pct === 100) {
      process.stderr.write(`[render] ${progress.stage} ${pct}%\n`)
    }
  }
}

async function runRender(options: CliOptions): Promise<number> {
  if (!options.projectPath) {
    throw new CliError('render requires a <project.json> argument')
  }
  const projectPath = path.resolve(options.projectPath)
  const project = await loadProjectDocument(projectPath)

  const resourcesDir = findResourcesDir(options.resources)
  const template = await loadTemplateById(resourcesDir, project.templateId)

  // Relative source paths resolve against the project file location.
  const sourcePath = path.isAbsolute(project.source.path)
    ? project.source.path
    : path.resolve(path.dirname(projectPath), project.source.path)
  if (!existsSync(sourcePath)) {
    throw new CliError(`Source clip not found: ${sourcePath}`)
  }
  const projectWithSource = {
    ...project,
    source: { ...project.source, path: sourcePath }
  }

  const baseName = sanitizeFileName(
    project.name || path.basename(sourcePath, path.extname(sourcePath))
  )
  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(process.cwd(), `${baseName}_${timestampSuffix()}.mp4`)

  const tmpRoot = options.tmp ? path.resolve(options.tmp) : defaultTmpRoot()
  const cacheDir = options.cache
    ? path.resolve(options.cache)
    : path.join(tmpRoot, 'cache', 'probes')

  const onProgress = progressPrinter()

  process.stderr.write(`[render] source: ${sourcePath}\n`)
  process.stderr.write(`[render] template: ${template.id} (${template.name})\n`)

  const result = await renderProject({
    project: projectWithSource,
    template,
    outputPath,
    resourcesDir,
    tmpRoot,
    probeCacheDir: cacheDir,
    ...(options.fps !== undefined ? { fps: options.fps } : {}),
    ...(options.crf !== undefined ? { crf: options.crf } : {}),
    ...(options.encoder !== undefined ? { encoder: options.encoder } : {}),
    ...(options.audio !== undefined ? { audio: options.audio } : {}),
    onProgress
  })

  if (process.stderr.isTTY === true) process.stderr.write('\n')
  process.stdout.write(`${result.outputPath}\n`)
  process.stdout.write(
    `  1080x1920 ${result.videoCodec} -> h264 yuv420p, ${result.durationSec.toFixed(1)}s, ` +
      `${formatBytes(result.sizeBytes)}, rendered in ${(result.elapsedMs / 1000).toFixed(1)}s\n`
  )
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      process.stderr.write(`[warn] ${warning}\n`)
    }
  }
  return 0
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // The downloader owns its own flag grammar (src/cli/dl.ts) — one dispatch, no
  // flag-sharing between two unrelated pipelines.
  if (argv[0] === 'dl') {
    return runDlCommand(argv.slice(1))
  }

  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`)
    return 1
  }

  if (options.command === 'help' || options.command === '--help' || options.command === '-h') {
    process.stdout.write(USAGE)
    return 0
  }
  if (options.command !== 'render') {
    process.stderr.write(`Unknown command "${options.command}"\n\n${USAGE}`)
    return 1
  }
  try {
    return await runRender(options)
  } catch (error) {
    if (error instanceof RenderCancelledError) {
      process.stderr.write('[render] cancelled\n')
      return 130
    }
    if (error instanceof RenderError) {
      process.stderr.write(`\n[error] ${error.stage}: ${error.message}\n`)
      if (error.stderrTail.length > 0) {
        process.stderr.write(`[error] ffmpeg stderr (last ${error.stderrTail.length} lines):\n`)
        for (const line of error.stderrTail) process.stderr.write(`  ${line}\n`)
      }
      return 1
    }
    if (error instanceof TemplateValidationError) {
      process.stderr.write(
        `[error] template invalid:\n  ${error.issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('\n  ')}\n`
      )
      return 1
    }
    if (error instanceof ProjectFileError || error instanceof CliError) {
      process.stderr.write(`[error] ${error.message}\n`)
      return 1
    }
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[error] ${message}\n`)
    return 1
  }
}

// tsx entry point. The repo is CJS (no "type": "module"), so require.main works;
// hooks/tests import `main` directly instead.
const invokedDirectly = (() => {
  try {
    return (
      typeof require !== 'undefined' &&
      typeof module !== 'undefined' &&
      (require as NodeRequire).main === (module as NodeModule)
    )
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  void main().then((code) => {
    process.exitCode = code
  })
}
