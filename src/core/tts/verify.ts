import type { AsrResult } from './asr'
import { stripDeliveryTags } from './chunks'

/** Strict normalized word verification plus pace and boundary checks. */

/** Indonesian narration target; VoxCPM sits near this before pacing. */
export const BASE_WPM = 130
/** All normalized words must match; recognizer errors conservatively fail. */
export const WORD_ACCEPT = 1
/** Char ratio at/above this accepts (observed whisper noise floor ≈0.94). */
export const CHAR_ACCEPT = 0.94
/** Best-of-N below word 0.75 or char 0.88 marks the chunk failed outright. */
export const WORD_FLOOR = 0.75
export const SIMILARITY_FLOOR = 0.88
/** A chunk faster/slower than ±25% of target WPM is a misgeneration. */
export const WPM_TOLERANCE = 0.25
/** Onsets closer than this to t=0 are reported (whisper-base floors word
 * starts at 0.0, so this is a warning, never a rejection). */
export const LEAD_CLIP_MS = 25

/**
 * Normalize for comparison the way the ASR hears it: lowercase, tags and
 * punctuation out, '%' spoken as "persen", and Indonesian number words
 * folded to digits — whisper freely swaps "enam puluh" ↔ "60".
 */
const NUM_UNITS: Record<string, number> = {
  nol: 0, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7,
  delapan: 8, sembilan: 9, sepuluh: 10, sebelas: 11, seratus: 100, seribu: 1000
}

/** "enam puluh dua" → ["62"]; bare "tiga" → ["3"]. */
function numberizeTokens(tokens: string[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (/^\d+$/.test(token)) {
      out.push(token)
      i += 1
      continue
    }
    const unit = NUM_UNITS[token]
    if (unit === undefined) {
      out.push(token)
      i += 1
      continue
    }
    if (unit >= 10 || unit === 0) {
      out.push(String(unit))
      i += 1
      continue
    }
    const next = tokens[i + 1]
    if (next === 'puluh' || next === 'belas') {
      const after = tokens[i + 2]
      let value = next === 'puluh' ? unit * 10 : unit + 10
      if (next === 'puluh' && after !== undefined && NUM_UNITS[after] !== undefined && NUM_UNITS[after]! > 0 && NUM_UNITS[after]! < 10) {
        value += NUM_UNITS[after]!
        i += 3
      } else {
        i += 2
      }
      out.push(String(value))
      continue
    }
    out.push(String(unit))
    i += 1
  }
  return out
}

export function normalizeForAsr(text: string): string {
  const raw = stripDeliveryTags(text)
    .toLowerCase()
    .replace(/%/g, ' persen ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return numberizeTokens(raw.split(' ').filter(Boolean)).join(' ')
}

/** Longest-common-subsequence length between two token sequences. */
function tokenLcs(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  let prev = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0)
    const token = a[i - 1]!
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = token === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!)
    }
    prev = row
  }
  return prev[b.length]!
}

/**
 * Fold whisper's tokenization artifacts back together: adjacent tokens whose
 * concatenation exists on the other side count as that one word
 * ("menyembunyikan mu" → "menyembunyikanmu"; "di samping" ↔ "disamping").
 */
function mergeSplits(tokens: string[], other: ReadonlySet<string>): string[] {
  const out: string[] = []
  let i = 0
  while (i < tokens.length) {
    const current = tokens[i]!
    const next = tokens[i + 1]
    if (next !== undefined && other.has(current + next)) {
      out.push(current + next)
      i += 2
      continue
    }
    out.push(current)
    i += 1
  }
  return out
}

/** Word-sequence ratio (2·LCS / total tokens): 1 = exact, no damage. */
export function wordSequenceRatio(expected: string, heard: string): number {
  let a = normalizeForAsr(expected).split(' ').filter(Boolean)
  let b = normalizeForAsr(heard).split(' ').filter(Boolean)
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  a = mergeSplits(a, new Set(b))
  b = mergeSplits(b, new Set(a))
  return (2 * tokenLcs(a, b)) / (a.length + b.length)
}

/** difflib-style character ratio (2·M / (lenA+lenB)) over an LCS match. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  // Rolling-row LCS over characters; inputs here are a few hundred chars.
  let prev = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0)
    const ca = a[i - 1]!
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = ca === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!)
    }
    prev = row
  }
  return (2 * prev[b.length]!) / (a.length + b.length)
}

export interface ChunkAttempt {
  seed: number
  /** Word-sequence ratio: 1 means the ASR heard the exact word sequence. */
  wordRatio: number
  similarity: number
  wpm: number
  expectedWpm: number
  durationOk: boolean
  leadClip: boolean
  stutter: boolean
  passed: boolean
  /** Blocking failures — each one forces a retry. */
  reasons: string[]
  /** Non-blocking notes surfaced in the report (whisper artifacts etc.). */
  warnings: string[]
  transcript: string
  mismatches: Array<{ expected: string | null; heard: string | null }>
  endTruncated: boolean
  rawTranscript?: string
  rawMismatches?: Array<{ expected: string | null; heard: string | null }>
  rawEndTruncated?: boolean
  rawReasons?: string[]
}

/** Minimum-edit word alignment, used to report every insertion, deletion and substitution. */
export function wordMismatches(expected: string, heard: string): ChunkAttempt['mismatches'] {
  let a = normalizeForAsr(expected).split(' ').filter(Boolean)
  let b = normalizeForAsr(heard).split(' ').filter(Boolean)
  a = mergeSplits(a, new Set(b))
  b = mergeSplits(b, new Set(a))
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  const errors: ChunkAttempt['mismatches'] = []
  let i = a.length, j = b.length
  while (i || j) {
    if (i && j && dp[i]![j] === dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      if (a[i - 1] !== b[j - 1]) errors.push({ expected: a[i - 1]!, heard: b[j - 1]! })
      i--; j--
    } else if (i && dp[i]![j] === dp[i - 1]![j]! + 1) {
      errors.push({ expected: a[--i]!, heard: null })
    } else {
      errors.push({ expected: null, heard: b[--j]! })
    }
  }
  return errors.reverse()
}

export interface ChunkVerification {
  attempts: ChunkAttempt[]
  /** Index of the selected take, including failed takes retained for review. */
  accepted: number
  retries: number
  /** Failed takes are kept for review and never count as verified. */
  status: 'verified' | 'failed'
}

function stuttered(transcript: string): boolean {
  const tokens = normalizeForAsr(transcript).split(' ').filter(Boolean)
  const head = tokens.slice(0, 3)
  for (let i = 1; i < head.length; i += 1) {
    if (head[i] === head[i - 1]) return true
    // A clipped first syllable often survives as a fragment: "per pertama".
    if (head[i]!.length > 2 && head[i]!.startsWith(head[i - 1]!)) return true
  }
  return false
}

/** Score one synthesis attempt of `expected` against what the ASR heard. */
export function checkAttempt(input: {
  expected: string
  seed: number
  asr: AsrResult
  baseWpm?: number
}): ChunkAttempt {
  const baseWpm = input.baseWpm ?? BASE_WPM
  const target = normalizeForAsr(input.expected)
  const heard = normalizeForAsr(input.asr.transcript)
  const wordRatio = wordSequenceRatio(target, heard)
  const ratio = similarity(target, heard)
  const wordCount = Math.max(1, target.split(' ').filter(Boolean).length)
  const durationSec = Math.max(0.001, input.asr.durationSec)
  const wpm = (wordCount / durationSec) * 60
  const expectedWpm = baseWpm
  const durationOk =
    wpm >= expectedWpm * (1 - WPM_TOLERANCE) && wpm <= expectedWpm * (1 + WPM_TOLERANCE)
  const firstWord = input.asr.words[0]
  const leadClip = firstWord !== undefined && firstWord.start * 1000 < LEAD_CLIP_MS
  const stutter = stuttered(input.asr.transcript) && !stuttered(input.expected)
  const mismatches = wordMismatches(input.expected, input.asr.transcript)
  const lastWord = input.asr.words[input.asr.words.length - 1]
  const expectedLast = target.split(' ').filter(Boolean).at(-1)
  const heardLast = normalizeForAsr(input.asr.words.map((word) => word.word).join(' ')).split(' ').filter(Boolean).at(-1)
  const endTruncated = !lastWord || !expectedLast || heardLast !== expectedLast ||
    lastWord.end >= input.asr.durationSec - 0.01 || lastWord.end <= lastWord.start

  const reasons: string[] = []
  if (mismatches.length)
    reasons.push(`word mismatch (ratio ${wordRatio.toFixed(2)}): heard "${heard.slice(0, 80)}"`)
  if (endTruncated) reasons.push('last word missing, truncated, or has invalid timestamps')
  if (ratio < CHAR_ACCEPT)
    reasons.push(`char similarity ${ratio.toFixed(2)} < ${CHAR_ACCEPT}`)
  if (!durationOk)
    reasons.push(`${wpm.toFixed(0)} wpm outside ${expectedWpm}±${WPM_TOLERANCE * 100}%`)
  if (stutter) reasons.push('leading stutter detected')

  const warnings: string[] = []
  if (leadClip) warnings.push('speech starts at 0ms — onset may be clipped (whisper floors word starts)')

  return {
    seed: input.seed,
    wordRatio: Math.round(wordRatio * 1000) / 1000,
    similarity: Math.round(ratio * 1000) / 1000,
    wpm: Math.round(wpm),
    expectedWpm,
    durationOk,
    leadClip,
    stutter,
    passed: reasons.length === 0,
    reasons,
    warnings,
    transcript: input.asr.transcript,
    mismatches,
    endTruncated
  }
}

/**
 * Rank attempts: fully passing beats everything; then word ratio, then char
 * similarity (both rounded to keep stable ordering on ties).
 */
function rank(a: ChunkAttempt): number {
  return (a.passed ? 1e9 : 0) + a.wordRatio * 1e6 + a.similarity
}

/** Fold attempts (best rank wins) into the chunk's verification record. */
export function summarizeVerification(attempts: ChunkAttempt[]): ChunkVerification {
  if (attempts.length === 0) throw new Error('No verification attempts recorded')
  let accepted = 0
  for (let i = 1; i < attempts.length; i += 1) {
    if (rank(attempts[i]!) > rank(attempts[accepted]!)) accepted = i
  }
  const passedIndex = attempts.findIndex((a) => a.passed)
  const status: ChunkVerification['status'] = passedIndex >= 0 ? 'verified' : 'failed'
  // When any attempt passed, the used take is that one (rank puts it first).
  if (passedIndex >= 0) accepted = passedIndex
  return { attempts, accepted, retries: attempts.length - 1, status }
}
