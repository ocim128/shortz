import type { DeliveryTagId } from '../../shared/tts/voices'

/**
 * Script → narration chunks (pure — unit-tested). Promotes the chunking that
 * lived inside voxcpm_worker.py plus the delivery-tag grammar:
 *
 *  - `[hook]` / `[tactical]` / `[twist]` tags apply from their position until
 *    the next tag or the end; they are stripped before synthesis and before
 *    ASR comparison.
 *  - Chunks are whole sentences (batched while they fit the model limit).
 *  - An over-long sentence is NEVER split mid-clause: it splits at clause
 *    boundaries (comma / ; / : / dash / Indonesian conjunction), and only an
 *    absurd run-on without any boundary falls back to word splits.
 */

/** VoxCPM2's practical per-generation text limit (matches the worker). */
export const CHUNK_CHAR_LIMIT = 300

export interface NarrationChunk {
  index: number
  /** Clean text — tags already stripped, whitespace normalized. */
  text: string
  /** Active delivery tag, or null for untagged narration. */
  tag: DeliveryTagId | null
}

const TAG_RE = /\[(hook|tactical|twist)\][ \t]*/gi
const SFX_RE = /\[sfx:([a-z0-9_-]+)\]/gi

/** Remove delivery tags and collapse the whitespace they leave behind. */
export function stripDeliveryTags(script: string): string {
  return script
    .replace(TAG_RE, ' ')
    .replace(SFX_RE, ' ')
    .replace(/\btok[\s.,!?]+tok[.!?,]*/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** A run of narration under one active tag (tag boundaries cut the run). */
interface Run {
  text: string
  tag: DeliveryTagId | null
}

/**
 * Split one over-long sentence at clause boundaries. The largest
 * boundary-bounded prefix within the limit wins, so clauses stay whole;
 * conjunction boundaries split BEFORE the conjunction word.
 */
export function splitLongSentence(sentence: string, limit = CHUNK_CHAR_LIMIT): string[] {
  if (sentence.length <= limit) return [sentence]
  const parts: string[] = []
  let rest = sentence
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = -1
    for (let i = window.length - 1; i >= 0; i -= 1) {
      const ch = window[i]
      if (ch === ',' || ch === ';' || ch === ':' || ch === '—') {
        cut = i + 1
        break
      }
    }
    if (cut <= 0) {
      const conjRe = /\s(yang|dan|tetapi|tapi|karena|atau|sehingga|lalu|kemudian|saat|ketika|sedangkan|hingga|sampai)\s/g
      let m: RegExpExecArray | null
      while ((m = conjRe.exec(window)) !== null) {
        cut = m.index + 1 // before the conjunction, after the preceding space
      }
    }
    if (cut <= 0) {
      // Last resort: word boundary; a run-on word with no space hard-splits.
      cut = rest.lastIndexOf(' ', limit)
      if (cut <= 0) {
        parts.push(rest.slice(0, limit))
        rest = rest.slice(limit)
        continue
      }
    }
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) parts.push(rest)
  return parts.filter((p) => p.length > 0)
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Sentence batching within one run (the worker's proven grouping). */
function chunkRun(run: Run, limit: number): string[] {
  const out: string[] = []
  let current = ''
  const emit = (): void => {
    const clean = current.trim()
    if (clean) out.push(clean)
    current = ''
  }
  for (const sentence of splitSentences(run.text)) {
    if (sentence.length > limit) {
      emit()
      for (const piece of splitLongSentence(sentence, limit)) {
        if (current && current.length + piece.length + 1 > limit) emit()
        current = current ? `${current} ${piece}` : piece
      }
      continue
    }
    if (current && (current.length + sentence.length + 1 > limit || splitSentences(current).length >= 3)) emit()
    current = current ? `${current} ${sentence}` : sentence
  }
  emit()
  return out
}

/** Script → ordered narration chunks (indices assigned in reading order). */
export function splitIntoChunks(script: string, limit = CHUNK_CHAR_LIMIT): NarrationChunk[] {
  return parseNarrationScript(script, limit).chunks
}

export function parseNarrationScript(script: string, limit = CHUNK_CHAR_LIMIT): {
  chunks: NarrationChunk[]; sfx: Array<{ name: string; beforeChunk: number }>
} {
  const chunks: NarrationChunk[] = []
  const sfx: Array<{ name: string; beforeChunk: number }> = []
  let tag: DeliveryTagId | null = null
  let cursor = 0
  const normalized = script.replace(/\btok[\s.,!?]+tok[.!?,]*/gi, '[sfx:knock]')
  const markers = /\[(hook|tactical|twist|sfx:([a-z0-9_-]+))\]/gi
  const flush = (text: string): void => {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return
    for (const text of chunkRun({ text: clean, tag }, limit)) {
      chunks.push({ index: chunks.length, text, tag })
    }
  }
  for (const match of normalized.matchAll(markers)) {
    flush(normalized.slice(cursor, match.index))
    if (match[2]) sfx.push({ name: match[2].toLowerCase(), beforeChunk: chunks.length })
    else tag = match[1]!.toLowerCase() as DeliveryTagId
    cursor = match.index! + match[0].length
  }
  flush(normalized.slice(cursor))
  return { chunks, sfx }
}

const ORDINALS = [
  'pertama', 'kedua', 'ketiga', 'keempat', 'kelima', 'keenam', 'ketujuh',
  'kedelapan', 'kesembilan', 'kesepuluh'
] as const

/**
 * A new numbered step ("Pertama, …" / "Kedua …" / "1. …") — these transitions
 * get the longer step gap in the stitch.
 */
export function startsNumberedStep(text: string): boolean {
  const lower = text.toLowerCase().replace(/^["'“]+/, '')
  if (/^\d+[.)]\s/.test(lower)) return true
  const first = (lower.split(/[\s,]+/)[0] ?? '').replace(/[^a-z]/g, '')
  return (ORDINALS as readonly string[]).includes(first)
}
