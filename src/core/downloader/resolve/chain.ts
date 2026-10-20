/**
 * The fallback chain — how adapter failures fold (resolver-chain.md §6).
 *
 * **Every adapter error falls through.** `NOT_EMBEDDABLE` ≠ "the post is gone".
 *
 * Terminal priority (rev 3, AUDIT A1):
 *  1. `NOT_FOUND` — terminal **only from the primary adapter**, or when the
 *     failure-path probe confirms it. A non-primary 404 (fxtwitter, yt-dlp) folds
 *     to NOT_EMBEDDABLE: a third party must never be authoritative about
 *     deletion (DA11).
 *  2. `RATE_LIMITED` — the retryable signal wins over a generic refusal.
 *  3. the last adapter's error.
 *
 * Then, and only on a terminal NOT_EMBEDDABLE, one failure-path probe
 * (`publish.twitter.com/oembed`) separates "deleted" (404) from "alive but
 * unembeddable" (200). It is live-verified (2026-10-20: 200 for an alive post,
 * 404 for a nonexistent one) and therefore ON by default; `probe: null` disables
 * it, which is what the hermetic tests do.
 */

import { DlError } from '../../../shared/downloader/errors'
import type { ResolvedTweet, ResolverName, TweetRef } from '../../../shared/downloader/types'
import type { DlClient } from '../net/client'
import type { ResolveCtx, Resolver } from './ctx'
import { FxTwitterResolver } from './fxtwitter'
import { SyndicationResolver } from './syndication'

/** 'gone' ⇒ the post does not exist; 'alive' ⇒ it does; 'unknown' ⇒ don't claim. */
export type ProbeResult = 'alive' | 'gone' | 'unknown'
export type FailureProbe = (ref: TweetRef, ctx: ResolveCtx) => Promise<ProbeResult>

export function oembedProbeUrl(canonicalUrl: string): string {
  return `https://publish.twitter.com/oembed?url=${encodeURIComponent(canonicalUrl)}&omit_script=1`
}

/** The one injectable probe (AUDIT A1). Never throws: 'unknown' on any trouble. */
export function createOembedProbe(client: DlClient): FailureProbe {
  return async (ref, ctx) => {
    try {
      const status = await client.probeStatus(oembedProbeUrl(ref.canonicalUrl), {
        signal: ctx.signal
      })
      if (status === 404) return 'gone'
      if (status >= 200 && status < 300) return 'alive'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }
}

function trail(names: readonly ResolverName[]): string {
  return `tried: ${names.join(' → ')}`
}

function withTrail(error: DlError, names: readonly ResolverName[]): DlError {
  return new DlError(error.code, `${error.detail ?? error.code} (${trail(names)})`)
}

/** A 404 from anyone but the primary adapter is not evidence of deletion. */
function foldOne(error: DlError, index: number, names: readonly ResolverName[]): DlError {
  if (index > 0 && error.code === 'NOT_FOUND') {
    return new DlError('NOT_EMBEDDABLE', `${error.detail ?? '404'} (${trail(names)})`)
  }
  return index === 0 ? error : withTrail(error, names)
}

/**
 * Fold the collected errors into the one the user sees.
 * Exported for the chain table tests.
 */
export function terminalError(
  errors: readonly DlError[],
  names: readonly ResolverName[],
  probeResult: ProbeResult = 'unknown'
): DlError {
  if (errors.length === 0) return new DlError('UPSTREAM_ERROR', 'the resolver chain is empty')

  const folded = errors.map((error, index) => foldOne(error, index, names))

  const primary = folded[0]
  if (primary !== undefined && primary.code === 'NOT_FOUND') {
    return new DlError('NOT_FOUND', primary.detail ?? trail(names))
  }
  const rateLimited = folded.find((error) => error.code === 'RATE_LIMITED')
  if (rateLimited !== undefined) return rateLimited

  const last = folded[folded.length - 1] as DlError
  if (last.code !== 'NOT_EMBEDDABLE') return last

  // A refusal: only the probe may turn it into "deleted".
  if (probeResult === 'gone') {
    return new DlError('NOT_FOUND', `probe says the post is gone (${trail(names)})`)
  }
  return new DlError('NOT_EMBEDDABLE', `${last.detail ?? 'not embeddable'} (${trail(names)})`)
}

export class FallbackChain {
  readonly names: readonly ResolverName[]

  constructor(
    private readonly adapters: readonly Resolver[],
    private readonly probe: FailureProbe | null = null
  ) {
    this.names = adapters.map((adapter) => adapter.name)
  }

  async resolve(ref: TweetRef, ctx: ResolveCtx): Promise<ResolvedTweet> {
    const errors: DlError[] = []
    for (const adapter of this.adapters) {
      try {
        return await adapter.resolve(ref, ctx)
      } catch (error) {
        if (error instanceof DlError) {
          if (error.code === 'CANCELLED') throw error
          errors.push(error)
        } else {
          const name = (error as { name?: string } | null | undefined)?.name
          if (name === 'AbortError') throw error
          errors.push(
            new DlError('UNEXPECTED', error instanceof Error ? error.message : String(error))
          )
        }
      }
    }

    const refused = terminalError(errors, this.names)
    if (refused.code !== 'NOT_EMBEDDABLE' || this.probe === null) throw refused

    const verdict = await this.probe(ref, ctx)
    throw terminalError(errors, this.names, verdict)
  }
}

/**
 * Composition by settings (port of xdl's `build_chain`, D-A16):
 * `off → [syndication]`, `fxtwitter → [syndication, fxtwitter]`,
 * `auto → [syndication]` — yt-dlp is not built in the MVP, so 'auto' silently
 * skips it and must NEVER raise an "install yt-dlp" error.
 */
export function buildChain(args: {
  fallback: 'off' | 'fxtwitter' | 'auto'
  client: DlClient
  /** `null` disables the failure-path probe; omitted ⇒ the live-verified oembed probe. */
  probe?: FailureProbe | null
}): FallbackChain {
  const adapters: Resolver[] = [new SyndicationResolver()]
  if (args.fallback === 'fxtwitter') adapters.push(new FxTwitterResolver())
  const probe = args.probe === undefined ? createOembedProbe(args.client) : args.probe
  return new FallbackChain(adapters, probe)
}
