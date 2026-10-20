/**
 * The resolver protocol and its context.
 *
 * Every adapter implements `resolve(ref, ctx)`; every adapter error falls
 * through to the next one (chain.ts). The engine never imports any of this —
 * `engine/fetch.ts` takes `(url, dest, ctx)` (xdl layering rule 6).
 */

import type { ResolvedTweet, TweetRef } from '../../../shared/downloader/types'
import type { DlClient } from '../net/client'

export interface ResolveCtx {
  client: DlClient
  signal: AbortSignal
  /** Counters for the CLI/tests: how many resolve requests this run made. */
  onRequest?: () => void
}

export interface Resolver {
  readonly name: 'syndication' | 'fxtwitter' | 'ytdlp'
  resolve(ref: TweetRef, ctx: ResolveCtx): Promise<ResolvedTweet>
}

/** Coerce an unknown payload into a record, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Both timestamp flavours (resolver-chain.md §3): ISO 8601 and Twitter's
 * `Wed Oct 22 15:33:18 +0000 2020`. Returns an ISO string, or null when the
 * value is absent/unusable — callers decide whether that is fatal.
 */
export function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

export function toIsoFromUnixSeconds(value: unknown): string | null {
  const seconds = asFiniteNumber(value)
  if (seconds === null || seconds <= 0) return null
  const parsed = new Date(seconds * 1000)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}
