import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThrottleState } from '../../../src/core/downloader/engine/throttle'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

function makeThrottle(minGapMs = 100, signal?: AbortSignal) {
  // The fake clock and `setTimeout` share one timeline here, so a test can assert
  // *when* a slot resolved, not merely that it did.
  return new ThrottleState(() => Date.now(), signal, { minGapMs })
}

describe('ThrottleState — pacing', () => {
  it('reserves slots before awaiting: 8 concurrent callers are strictly serialized', async () => {
    const throttle = makeThrottle(100)
    const order: number[] = []

    const waiting = Array.from({ length: 8 }, () =>
      throttle.gate().then(() => {
        order.push(Date.now())
      })
    )

    // All eight ran up to their first await synchronously, so the last slot is
    // already reserved — the burst happened in the *bookkeeping*, not on the wire.
    expect(throttle.snapshot().lastRequest).toBe(700)

    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all(waiting)

    expect(order).toHaveLength(8)
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index] as number).toBeGreaterThanOrEqual(order[index - 1] as number)
    }
    expect(order[0]).toBe(0)
    expect(order[7]).toBe(700)
  })

  it('delayFor is 0 for a fresh caller and grows behind the last slot', async () => {
    const throttle = makeThrottle(100)
    expect(throttle.delayFor()).toBe(0)
    const first = throttle.gate()
    const second = throttle.gate()
    // The next free slot is one gap behind the one already reserved.
    expect(throttle.delayFor()).toBe(200)
    await vi.advanceTimersByTimeAsync(500)
    await Promise.all([first, second])
    expect(throttle.delayFor()).toBe(0)
  })
})

describe('ThrottleState — 429 handling', () => {
  it('report429 without a usable header pauses for the 30 s floor', () => {
    const throttle = makeThrottle(100)
    throttle.report429(null)
    expect(throttle.snapshot().pauseUntil).toBe(30_000)
    // Two pauses inside one window do not stack: the floor is a floor.
    throttle.report429('not-a-date')
    expect(throttle.snapshot().pauseUntil).toBe(30_000)
  })

  it('takes a Retry-After that is longer than the floor', () => {
    const throttle = makeThrottle(100)
    throttle.report429('90')
    expect(throttle.snapshot().pauseUntil).toBe(90_000)
  })

  it('WAKE-AND-RECHECK: callers already sleeping do not fire inside the cooldown', async () => {
    const throttle = makeThrottle(100)
    const resolvedAt: number[] = []
    const track = (): Promise<void> =>
      throttle.gate().then(() => {
        resolvedAt.push(Date.now())
      })

    const first = track() // slot 0
    const second = track() // slot 100
    const third = track() // slot 200

    await vi.advanceTimersByTimeAsync(150)
    expect(resolvedAt).toEqual([0, 100])

    // A 429 lands while `third` is still asleep in gate().
    throttle.reportPause(30_000)
    const pauseUntil = throttle.snapshot().pauseUntil
    expect(pauseUntil).toBe(30_150)

    // Its original slot (200) came and went — it must NOT fire there.
    await vi.advanceTimersByTimeAsync(24_000)
    expect(resolvedAt).toEqual([0, 100])

    await vi.advanceTimersByTimeAsync(7_000)
    await Promise.all([first, second, third])
    expect(resolvedAt[2]).toBeGreaterThanOrEqual(pauseUntil)
  })

  it('a new caller waits for the pause, not just the gap', async () => {
    const throttle = makeThrottle(5)
    throttle.reportPause(30_000)
    let done = false
    const waiting = throttle.gate().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(29_000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1_100)
    await waiting
    expect(done).toBe(true)
  })

  it('escalates once at 3 pauses in the window, doubling to at least 120 s', () => {
    const throttle = makeThrottle(100)
    throttle.report429('40')
    expect(throttle.snapshot().escalations).toBe(0)
    vi.setSystemTime(1_000)
    throttle.report429('40')
    expect(throttle.snapshot().escalations).toBe(0)
    vi.setSystemTime(2_000)
    throttle.report429('40')

    const snapshot = throttle.snapshot()
    expect(snapshot.escalations).toBe(1)
    // 40 s floor × 2 = 80 s, raised to the 120 s escalation floor; measured from
    // the third report (t = 2 s).
    expect(snapshot.pauseUntil).toBe(122_000)
  })

  it('forgets old 429s outside the 60 s window (no false escalation)', () => {
    const throttle = makeThrottle(100)
    throttle.report429('1')
    throttle.report429('1')
    vi.setSystemTime(61_000)
    throttle.report429('1')
    expect(throttle.snapshot().escalations).toBe(0)
    expect(throttle.snapshot().pauseUntil).toBe(91_000)
  })

  it('never shortens a pause that is already longer', () => {
    const throttle = makeThrottle(100)
    throttle.reportPause(60_000)
    vi.setSystemTime(1_000)
    throttle.reportPause(10_000)
    expect(throttle.snapshot().pauseUntil).toBe(60_000)
  })
})

describe('ThrottleState — cancellation', () => {
  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const throttle = makeThrottle(100, controller.signal)
    await expect(throttle.gate()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects a sleeping caller when the signal fires', async () => {
    const controller = new AbortController()
    const throttle = makeThrottle(5, controller.signal)
    // A pause is what puts the caller inside sleep(); the first caller of a
    // fresh throttle never waits.
    throttle.reportPause(30_000)
    const waiting = throttle.gate()
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  })
})
