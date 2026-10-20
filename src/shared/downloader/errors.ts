/**
 * Typed downloader errors — the one union everything throws and switches on.
 *
 * Pure: no `node:`, no DOM. Sentences live in `copy.ts`, never here (AUDIT A7):
 * an event carries the code plus a raw detail, and the main process / CLI /
 * renderer phrase it.
 */

import type { DlErrorCode } from './types'

export class DlError extends Error {
  readonly code: DlErrorCode
  readonly detail?: string
  /**
   * Additive (see NOTES-A): milliseconds from a 429's `Retry-After`, when the
   * server said so. The throttle uses it for the global pause; code that only
   * reads `code`/`detail` is unaffected.
   */
  readonly retryAfterMs?: number

  constructor(code: DlErrorCode, detail?: string, options: { retryAfterMs?: number } = {}) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'DlError'
    this.code = code
    if (detail !== undefined) this.detail = detail
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}

/**
 * Retryability per `technical/resolver-chain.md` §7. Note that `LINK_EXPIRED`
 * and `INTEGRITY_MISMATCH` are retryable *exactly once* — the orchestrator owns
 * that bound (re-resolve / clean restart); a generic loop must not use
 * `retryable()` alone for them.
 */
const RETRYABLE: ReadonlySet<DlErrorCode> = new Set<DlErrorCode>([
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'NETWORK',
  'LINK_EXPIRED',
  'INTEGRITY_MISMATCH'
])

export function retryable(code: DlErrorCode): boolean {
  return RETRYABLE.has(code)
}

/** A user cancel is not a failure — `AbortError`/`CANCELLED` share one shape. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DlError) return error.code === 'CANCELLED'
  const name = (error as { name?: string } | null | undefined)?.name
  // NOTE: `TimeoutError` (AbortSignal.timeout) is deliberately NOT an abort — a
  // timeout is `NETWORK` weather, while a cancel is the user's decision.
  return name === 'AbortError'
}

/**
 * Anything that reaches a verdict. A `DlError` passes through; an abort becomes
 * `CANCELLED`; anything else is a bug in one item, never weather — `UNEXPECTED`.
 */
export function asDlError(error: unknown): DlError {
  if (error instanceof DlError) return error
  if (isAbortError(error)) {
    return new DlError('CANCELLED', error instanceof Error ? error.message : String(error))
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return new DlError(
      'UNEXPECTED',
      code === undefined ? error.message : `${code}: ${error.message}`
    )
  }
  return new DlError('UNEXPECTED', String(error))
}
