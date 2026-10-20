/**
 * The ONE Windows-safe filename sanitizer (AUDIT A15).
 *
 * Pure string work (no `node:`, no DOM) because two tiers need exactly the same
 * rules: `src/main/output-path.ts` for export/batch names (Tier 3) and
 * `src/shared/downloader/naming.ts` for download paths (pure tier). Two copies
 * of "what Windows rejects" is how drift comes back — `video-extensions.ts`
 * exists for the same reason.
 *
 * Rules (docs/twitter-downloader/technical/storage-naming.md §2):
 *  1. NFC normalize (macOS/Linux copies of the same caption stay comparable).
 *  2. `< > : " / \ | ? *` and control chars 0x00–0x1F become `_`.
 *  3. Trailing spaces and dots are stripped — NTFS drops them silently, which
 *     turns `report.` and `report` into the same file.
 *  4. Reserved device names get an `_` prefix (CON, PRN, AUX, NUL, COM1–9, LPT1–9).
 *  5. Segments cap at 120 chars, truncated on a char boundary without leaving a
 *     lone surrogate, then re-stripped of ` ` and `.`.
 *  6. An empty result becomes `_`.
 */

/** Segment cap, in UTF-16 code units. Leaves headroom inside the 255-byte name limit. */
export const MAX_SEGMENT_LENGTH = 120

/** Characters NTFS/FAT reject outright, plus C0 controls. */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g

/** Windows device names, optionally with an extension (`CON.txt` is just as invalid). */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

/** Trailing spaces and dots — invalid on NTFS and silently dropped by Explorer. */
const TRAILING_JUNK = /[ .]+$/

export interface SanitizeOptions {
  /** Per-segment cap in code units. Defaults to {@link MAX_SEGMENT_LENGTH}. */
  maxLength?: number
}

/**
 * Truncate without splitting a surrogate pair: cutting `😀` in half leaves a
 * lone surrogate that Windows renders as `?` and that can break JSON round-trips.
 */
export function truncateSurrogateSafe(value: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (value.length <= maxLength) return value
  let end = maxLength
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return value.slice(0, end)
}

/** Sanitize one path segment. Never returns an empty string. */
export function sanitizeSegment(value: string, options: SanitizeOptions = {}): string {
  const maxLength = options.maxLength ?? MAX_SEGMENT_LENGTH
  let out = value.normalize('NFC').replace(FORBIDDEN, '_')
  out = out.replace(TRAILING_JUNK, '')
  if (RESERVED_DEVICE.test(out)) out = `_${out}`
  out = truncateSurrogateSafe(out, maxLength).replace(TRAILING_JUNK, '')
  return out.length === 0 ? '_' : out
}

/**
 * A caller-visible name part: trimmed first (export patterns concatenate parts,
 * so a stray space would become a dangling separator), then sanitized.
 */
export function sanitizeNamePart(value: string, options: SanitizeOptions = {}): string {
  return sanitizeSegment(value.trim(), options)
}
