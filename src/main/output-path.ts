import path from 'node:path'

/**
 * Output filename convention (docs/technical/export-spec.md §filename
 * convention) — shared by the single-project export and the batch queue so a
 * batch run produces exactly the names a manual export would.
 *
 * Pattern tokens: {name} {template} {seq} {yyyyMMdd} {HHmm}.
 * Unknown tokens are kept verbatim, and the result is stripped of characters
 * Windows rejects so a title with `:` or `?` cannot fail the move at the end of
 * a long render.
 */

export function sanitizeNamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').trim()
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
    HHmm: `${pad2(now.getHours())}${pad2(now.getMinutes())}`,
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
  base = sanitizeNamePart(base).replace(/^_+|_+$/g, '').slice(0, 80)
  if (base.length === 0) base = 'export'
  return path.join(input.dir, `${base}.mp4`)
}
