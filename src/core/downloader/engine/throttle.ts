/**
 * Pacing with one shared brain (download-engine.md §2, port of xdl's throttle).
 *
 * Three properties matter, and each has a test:
 *  1. **One clock, monotonic.** `performance.now()` by default — `Date.now()` can
 *     step backwards under NTP and corrupt the cooldown math.
 *  2. **Slot reservation before any await.** `lastRequest` is advanced to the
 *     slot THIS caller will occupy synchronously, so 8 concurrent callers queue
 *     behind each other instead of bursting.
 *  3. **Wake-and-recheck.** A caller already sleeping in `gate()` when a 429
 *     lands re-checks the pause after waking and goes back to sleep — otherwise
 *     it would fire inside the cooldown, collect fresh 429s and falsely trip the
 *     3-in-60 s escalation. This hardens the reference implementation too.
 *
 * One instance per run: resolve and download share it, so one worker's 429
 * pauses everyone.
 */

import { parseRetryAfter } from '../net/client'

/** Default gap between request starts, jittered so a batch does not look like a burst. */
const MIN_GAP_LOW_MS = 200
const MIN_GAP_HIGH_MS = 500

const PAUSE_FLOOR_MS = 30_000
const ESCALATED_PAUSE_MS = 120_000
const ESCALATION_WINDOW_MS = 60_000

export interface ThrottleOptions {
  /** Override the jittered gap (`SHORTZ_THROTTLE_MS` in the CLI). */
  minGapMs?: number
  /** Pause floor for a 429 without a usable Retry-After. */
  pauseFloorMs?: number
}

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/** `setTimeout` that rejects with an AbortError when `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      },
      Math.max(0, ms)
    )
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class ThrottleState {
  private readonly minGap: number
  private readonly pauseFloor: number
  private pauseUntil = 0
  /** `-Infinity` (not 0): the FIRST request must not wait a full gap. With a real
   * clock `now` dwarfs 0 and hides the difference; a test clock starting at 0
   * does not. */
  private lastRequest = Number.NEGATIVE_INFINITY
  private recent429: number[] = []
  private escalations = 0

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly signal?: AbortSignal,
    options: ThrottleOptions = {}
  ) {
    this.minGap =
      options.minGapMs ?? MIN_GAP_LOW_MS + Math.random() * (MIN_GAP_HIGH_MS - MIN_GAP_LOW_MS)
    this.pauseFloor = options.pauseFloorMs ?? PAUSE_FLOOR_MS
  }

  /** Milliseconds until this caller may send its request (0 = now). */
  delayFor(): number {
    const now = this.now()
    if (now < this.pauseUntil) return this.pauseUntil - now
    return Math.max(0, this.lastRequest + this.minGap - now)
  }

  async gate(): Promise<void> {
    for (;;) {
      if (this.signal?.aborted === true) throw abortError()
      const now = this.now()
      if (now < this.pauseUntil) {
        await sleep(this.pauseUntil - now, this.signal)
        continue
      }
      // SLOT RESERVATION: advance lastRequest to the slot THIS caller will
      // occupy, before any await (no await between the read and the write).
      const slot = Math.max(now, this.lastRequest + this.minGap)
      this.lastRequest = slot
      if (slot > now) {
        await sleep(slot - now, this.signal)
        if (this.now() < this.pauseUntil) continue // a 429 landed mid-sleep
      }
      return
    }
  }

  /** `Retry-After` (seconds or HTTP-date); absent/invalid → the 30 s floor. */
  report429(retryAfterHeader?: string | null): void {
    this.reportPause(parseRetryAfter(retryAfterHeader ?? null) ?? this.pauseFloor)
  }

  /** Milliseconds form, for a `DlError.retryAfterMs` the client already parsed. */
  report429Ms(ms: number | null | undefined): void {
    this.reportPause(ms ?? this.pauseFloor)
  }

  reportPause(ms: number): void {
    const now = this.now()
    this.recent429 = this.recent429.filter((at) => now - at < ESCALATION_WINDOW_MS)
    this.recent429.push(now)
    let pause = Math.max(ms, this.pauseFloor)
    if (this.recent429.length >= 3) {
      this.escalations += 1
      pause = Math.max(pause * 2, ESCALATED_PAUSE_MS)
    }
    this.pauseUntil = Math.max(this.pauseUntil, now + pause)
    // Callers already queued in gate() must not slot themselves into the
    // cooldown we just set.
    this.lastRequest = Math.max(this.lastRequest, this.pauseUntil)
  }

  /** Test/diagnostic view. */
  snapshot(): { pauseUntil: number; lastRequest: number; minGap: number; escalations: number } {
    return {
      pauseUntil: this.pauseUntil,
      lastRequest: this.lastRequest,
      minGap: this.minGap,
      escalations: this.escalations
    }
  }
}
