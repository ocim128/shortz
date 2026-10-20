/**
 * The Downloader textarea parser — shared by the renderer preview and the core.
 *
 * Pure: no `node:`, no DOM. One entry per NON-BLANK physical line, in order, with
 * `key = 'line-<lineNumber>'` so the renderer's row map cannot shift when a line
 * is a duplicate, has two links, or is junk (AUDIT A4/A22).
 *
 * The renderer's parse is a **preview**: `runDl` re-parses the same text and owns
 * the authoritative duplicate verdict (first occurrence wins). Nothing here
 * throws — every line comes back with the problems found.
 */

import { DlError } from './errors'
import { extractAllStatusUrls, extractStatusUrl, isTcoUrl, parseStatusUrl } from './urls'

export type DlLineProblemCode =
  | 'no-link'
  | 'invalid-id'
  | 'short-link' // not a problem: "will expand"
  | 'duplicate'
  | 'multiple-links'

export interface ParsedLine {
  /** 'line-<lineNumber>' — stable per physical line. */
  key: string
  /** 1-based physical line number. */
  lineNumber: number
  /** The line exactly as typed (trimmed). */
  text: string
  /** The extracted URL substring, or null. */
  url: string | null
  /** The 2..19-digit id when one was parsed, else null (t.co links have none yet). */
  tweetId: string | null
  problems: DlLineProblemCode[]
}

/** The stable key for one physical line — the row-map identity. */
export function lineKey(lineNumber: number): string {
  return `line-${lineNumber}`
}

/**
 * Parse the textarea. Blank lines and `# …` comments are dropped (a trailing
 * newline is not an item); every other line is returned with its problems, so one
 * bad line never hides the ones around it. A comment is only a `#` at line start
 * (`ui-and-ipc.md` §2) — X URLs contain no `#`, and a `#` mid-line is preserved.
 */
export function parseRunInput(text: string): ParsedLine[] {
  const lines: ParsedLine[] = []
  const firstSeen = new Map<string, number>()
  const raw = text.split(/\r?\n/)

  for (let index = 0; index < raw.length; index += 1) {
    const trimmed = (raw[index] ?? '').trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    const lineNumber = index + 1
    const problems: DlLineProblemCode[] = []
    const url = extractStatusUrl(trimmed)
    let tweetId: string | null = null

    if (url === null) {
      problems.push('no-link')
    } else if (isTcoUrl(url) && !hasStatusForm(url)) {
      // A short link is not a problem: the core expands it (one hop) before parsing.
      problems.push('short-link')
    } else {
      try {
        tweetId = parseStatusUrl(url).tweetId
      } catch (error) {
        const code = error instanceof DlError ? error.code : 'URL_UNRECOGNIZED'
        problems.push(code === 'TWEET_ID_INVALID' ? 'invalid-id' : 'no-link')
      }
    }

    if (extractAllStatusUrls(trimmed).length > 1) problems.push('multiple-links')

    if (tweetId !== null) {
      // Preview only — `runDl` owns the verdict, but the user should see it now.
      if (firstSeen.has(tweetId)) problems.push('duplicate')
      else firstSeen.set(tweetId, lineNumber)
    }

    lines.push({
      key: lineKey(lineNumber),
      lineNumber,
      text: trimmed,
      url,
      tweetId,
      problems
    })
  }

  return lines
}

function hasStatusForm(url: string): boolean {
  try {
    parseStatusUrl(url)
    return true
  } catch {
    return false
  }
}

/** True when a line has a blocking problem (only `short-link` is benign). */
export function hasBlockingProblem(line: ParsedLine): boolean {
  return line.problems.some((problem) => problem !== 'short-link')
}
