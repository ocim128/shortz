/**
 * Batch line parser — the one place that knows the `path•hook` format.
 *
 * Pure string work (no node:path, no DOM) so the renderer previews exactly what
 * the main process will render. One line per video:
 *
 *   C:\Users\user\Videos\ShortZ\tupai.mp4•TUPAI YG LUCU
 *
 * Rules:
 * - `•` (U+2022) separates the file location from the hook text. The split
 *   point is the first `•` whose left side ends in a video extension, so a
 *   bullet typed inside a hook (or inside a folder name) cannot break the line.
 * - Explorer's "Copy as path" wraps the location in double quotes — stripped.
 * - Blank lines are ignored; every other line becomes one item.
 */

import { VIDEO_EXTENSIONS } from '../video-extensions'

/** The separator between the file location and the hook text. */
export const BATCH_SEPARATOR = '•'

export type BatchLineProblemCode =
  /** Nothing before the separator (or the whole line was empty). */
  | 'missing-path'
  /** The location does not end in a known video extension. */
  | 'unsupported-extension'
  /** The same location already appeared on an earlier line. */
  | 'duplicate-path'

export interface BatchLineProblem {
  code: BatchLineProblemCode
  /** Human-readable detail (the offending extension, the earlier line number). */
  detail?: string
}

export interface BatchLine {
  /** 0-based position among the non-blank lines — the render queue index. */
  index: number
  /** 1-based line number in the textarea, for error messages. */
  lineNumber: number
  /** The line exactly as typed (trimmed) — echoed back in the UI. */
  raw: string
  /** File location, quotes stripped. */
  path: string
  /** Hook text; empty when the separator or the text after it is missing. */
  hook: string
  /** True when a separator was found (even with an empty hook after it). */
  hasSeparator: boolean
  /** Blocking problems with the line itself (not the template's demands). */
  problems: BatchLineProblem[]
}

/** Strip Explorer's "Copy as path" quoting and surrounding whitespace. */
export function normalizeBatchPath(value: string): string {
  let out = value.trim()
  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) {
    out = out.slice(1, -1).trim()
  }
  return out
}

/** Lowercase extension without the dot, or '' when the path has none. */
export function extensionOf(filePath: string): string {
  const name = basenameOf(filePath)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * Slash-agnostic basename. The renderer must not import node:path, and batch
 * paste comes from Windows Explorer, so both separators are honoured.
 */
export function basenameOf(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return at >= 0 ? trimmed.slice(at + 1) : trimmed
}

/** Basename without its extension — the default output `{name}`. */
export function stemOf(filePath: string): string {
  const base = basenameOf(filePath)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export function isVideoPath(filePath: string): boolean {
  const ext = extensionOf(filePath)
  return ext.length > 0 && (VIDEO_EXTENSIONS as readonly string[]).includes(ext)
}

/** All indices of a (single-char) needle in a string. */
function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return out
    out.push(at)
    from = at + needle.length
  }
}

function splitLine(line: string): { path: string; hook: string; hasSeparator: boolean } {
  const positions = indicesOf(line, BATCH_SEPARATOR)
  if (positions.length === 0) return { path: line, hook: '', hasSeparator: false }

  // Prefer the first separator whose left side already looks like a video path:
  // that keeps `...\a.mp4•Hook • with a bullet` intact.
  for (const at of positions) {
    const left = normalizeBatchPath(line.slice(0, at))
    if (isVideoPath(left)) {
      return { path: left, hook: line.slice(at + BATCH_SEPARATOR.length), hasSeparator: true }
    }
  }
  // No path-shaped left side: fall back to the first separator so the problem
  // is reported against the location, not swallowed into the hook text.
  const first = positions[0] as number
  return {
    path: line.slice(0, first),
    hook: line.slice(first + BATCH_SEPARATOR.length),
    hasSeparator: true
  }
}

/**
 * Parse the batch textarea. Never throws: every non-blank line is returned with
 * the problems found, so the UI can show a per-line verdict while typing.
 */
export function parseBatchText(text: string): BatchLine[] {
  const lines: BatchLine[] = []
  const firstSeenAt = new Map<string, number>()
  const rawLines = text.split(/\r?\n/)

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = (rawLines[i] ?? '').trim()
    if (raw.length === 0) continue

    const split = splitLine(raw)
    const filePath = normalizeBatchPath(split.path)
    const hook = split.hook.trim()
    const problems: BatchLineProblem[] = []

    if (filePath.length === 0) {
      problems.push({ code: 'missing-path' })
    } else if (!isVideoPath(filePath)) {
      const ext = extensionOf(filePath)
      problems.push({
        code: 'unsupported-extension',
        detail: ext.length > 0 ? `.${ext}` : 'no extension'
      })
    } else {
      const key = filePath.toLowerCase()
      const earlier = firstSeenAt.get(key)
      if (earlier !== undefined) {
        problems.push({ code: 'duplicate-path', detail: `line ${earlier}` })
      } else {
        firstSeenAt.set(key, i + 1)
      }
    }

    lines.push({
      index: lines.length,
      lineNumber: i + 1,
      raw,
      path: filePath,
      hook,
      hasSeparator: split.hasSeparator,
      problems
    })
  }

  return lines
}

/**
 * Which template input receives the hook text. Mirrors what the render engine
 * validates: the first required input, else the first declared one.
 */
export function hookFieldKeyOf(inputs: readonly { key: string; required?: boolean }[]): string {
  return inputs.find((field) => field.required === true)?.key ?? inputs[0]?.key ?? 'hook'
}
