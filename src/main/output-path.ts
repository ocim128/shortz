import path from 'node:path'
import { sanitizeNamePart as sanitizeNameSegment } from '../shared/naming'

/**
 * Output filename convention (docs/technical/export-spec.md §filename
 * convention) — shared by the single-project export and the batch queue so a
 * batch run produces exactly the names a manual export would.
 *
 * Pattern tokens: {name} {template} {seq} {yyyyMMdd} {HHmm}.
 * Unknown tokens are kept verbatim, and the result is stripped of characters
 * Windows rejects so a title with `:` or `?` cannot fail the move at the end of
 * a long render.
 *
 * The character rules themselves live in `src/shared/naming.ts` (AUDIT A15: one
 * Windows rule set for both the exporter and the downloader). This module keeps
 * its own *policy* — the 80-char export-name cap — which is about export naming,
 * not about what Windows accepts.
 */

/** Export-name policy: names are short so a folder of exports stays readable. */
const MAX_EXPORT_NAME_LENGTH = 80

export function sanitizeNamePart(value: string): string {
  return sanitizeNameSegment(value)
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

export interface OutputPathInput {
  dir: string
  pattern: string
  /** `{name}` — the project name (single export) or the clip stem (batch). */
  name: string
  /** `{template}` */
  templateId: string
  /** `{seq}` — 1-based batch position; single exports keep the documented "1". */
  seq?: number
  now?: Date
}

export function buildOutputPath(input: OutputPathInput): string {
  const now = input.now ?? new Date()
  const tokens: Record<string, string> = {
    name: sanitizeNamePart(input.name),
    template: sanitizeNamePart(input.templateId),
    seq: String(input.seq ?? 1),
    yyyyMMdd: `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`,
    HHmm: `${pad2(now.getHours())}${pad2(now.getMinutes())}`
  }

  let base = ''
  const tokensRe = /\{(\w+)\}/g
  let last = 0
  for (const m of input.pattern.matchAll(tokensRe)) {
    const key = m[1] as string
    base += input.pattern.slice(last, m.index ?? 0)
    base += sanitizeNamePart(tokens[key] ?? `{${key}}`)
    last = (m.index ?? 0) + m[0].length
  }
  base += input.pattern.slice(last)
  const stripped = sanitizeNamePart(base)
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_EXPORT_NAME_LENGTH)
  // Re-sanitize the final name: stripping separators can surface a reserved
  // device name (a project called "CON") that the sanitizer had prefixed.
  const finalName = stripped.length === 0 ? 'export' : sanitizeNamePart(stripped)
  const safeName = finalName.length === 0 ? 'export' : finalName
  return path.join(input.dir, `${safeName}.mp4`)
}
