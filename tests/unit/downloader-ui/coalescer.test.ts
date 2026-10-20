import { describe, expect, it } from 'vitest'
import { createDlEventCoalescer } from '../../../src/main/dl-coalesce'
import type {
  DlEvent,
  DlItemEvent,
  DlMediaProgressEvent
} from '../../../src/shared/downloader/types'

/** Deterministic timer seam: the coalescer never touches a real clock here. */
function makeClock(): {
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancelSchedule: (handle: ReturnType<typeof setTimeout>) => void
  advance: (ms: number) => void
  pending: () => number
} {
  let time = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    schedule: (fn, ms) => {
      const id = nextId++
      timers.set(id, { at: time + ms, fn })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    cancelSchedule: (handle) => {
      timers.delete(handle as unknown as number)
    },
    advance: (ms) => {
      time += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    pending: () => timers.size
  }
}

function tick(
  overrides: Partial<DlMediaProgressEvent> & Pick<DlMediaProgressEvent, 'mediaIndex' | 'bytes'>
): DlMediaProgressEvent {
  return {
    jobId: 'job-1',
    kind: 'media-progress',
    key: 'line-1',
    lineNumber: 1,
    index: 0,
    itemTotal: 3,
    total: 1000,
    ...overrides
  }
}

function item(status: DlItemEvent['item']['status'], key = 'line-1'): DlItemEvent {
  return {
    jobId: 'job-1',
    kind: 'item',
    key,
    lineNumber: Number(key.slice('line-'.length)),
    index: 0,
    total: 3,
    item: { tweetId: '1750123456789012352', status }
  }
}

function setup(): {
  push: (e: DlEvent) => void
  events: DlEvent[]
  advance: (ms: number) => void
  clock: ReturnType<typeof makeClock>
} {
  const events: DlEvent[] = []
  const clock = makeClock()
  const coalescer = createDlEventCoalescer({
    emit: (e) => events.push(e),
    intervalMs: 100,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule
  })
  return { push: coalescer.push, events, advance: clock.advance, clock }
}

describe('downloader event coalescer', () => {
  it('collapses a burst of ticks to one event per media at ~10 Hz', () => {
    const { push, events, advance } = setup()
    for (let n = 1; n <= 20; n += 1) {
      push(tick({ mediaIndex: 1, bytes: n * 10 }))
      push(tick({ mediaIndex: 2, bytes: n * 5, key: 'line-2', lineNumber: 2 }))
    }
    expect(events).toHaveLength(0)
    advance(100)
    expect(events).toHaveLength(2)
    const latest = events.find((e) => e.kind === 'media-progress' && e.mediaIndex === 1)
    expect(latest).toMatchObject({ kind: 'media-progress', bytes: 200 })
  })

  it('sends status transitions immediately and flushes pending ticks first', () => {
    const { push, events, advance } = setup()
    push(tick({ mediaIndex: 1, bytes: 40 }))
    push(item('downloading'))
    // The transition went out without waiting for the 100 ms beat…
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'media-progress', bytes: 40 })
    expect(events[1]).toMatchObject({ kind: 'item', item: { status: 'downloading' } })
    // …and the timer is cleared, so nothing stale lands after it.
    advance(500)
    expect(events).toHaveLength(2)
  })

  it('drops buffered ticks on run-done', () => {
    const { push, events, advance } = setup()
    push(tick({ mediaIndex: 1, bytes: 99 }))
    push({
      jobId: 'job-1',
      kind: 'run-done',
      total: 1,
      summary: { ok: 0, skipped: 0, partial: 0, failed: 1, cancelled: false },
      cancelled: false
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('run-done')
    advance(500)
    expect(events).toHaveLength(1)
  })

  it('does not reschedule a flush when the buffer is empty', () => {
    const { push, advance, clock } = setup()
    push(item('resolving'))
    expect(clock.pending()).toBe(0)
    advance(100)
    expect(clock.pending()).toBe(0)
  })
})
