import { describe, expect, it } from 'vitest'
import { toProgressEvent } from '../../src/main/progress'
import type { OrchestratorProgress } from '../../src/core/render/orchestrator'

function progress(overrides: Partial<OrchestratorProgress>): OrchestratorProgress {
  return { jobId: 'J', stage: 'render', pct: 0, ...overrides }
}

describe('toProgressEvent', () => {
  it('computes eta from the duration it is given (the trimmed one)', () => {
    const event = toProgressEvent(
      progress({ outTimeSec: 5, speed: '2x', pct: 50 }),
      10
    )
    expect(event.etaSec).toBe(2.5)
    expect(event.percent).toBe(50)
    expect(event.speed).toBe(2)
    expect(event.done).toBe(false)
  })

  it('drops eta once the output timeline reaches the duration', () => {
    const event = toProgressEvent(progress({ outTimeSec: 10, speed: '2x', pct: 100 }), 10)
    expect(event.etaSec).toBeNull()
  })

  it('emits no eta without a parseable speed', () => {
    expect(toProgressEvent(progress({ outTimeSec: 5, speed: null, pct: 50 }), 10).etaSec).toBeNull()
    expect(toProgressEvent(progress({ outTimeSec: 5, speed: 'N/A', pct: 50 }), 10).etaSec).toBeNull()
    expect(toProgressEvent(progress({ outTimeSec: 5, speed: undefined, pct: 50 }), 10).etaSec).toBeNull()
  })

  it('marks the done stage and zeroes its eta', () => {
    const event = toProgressEvent(progress({ stage: 'done', pct: 100, outTimeSec: 10 }), 10)
    expect(event.done).toBe(true)
    expect(event.etaSec).toBeNull()
  })

  it('clamps percent into 0-100', () => {
    expect(toProgressEvent(progress({ pct: -5 }), 10).percent).toBe(0)
    expect(toProgressEvent(progress({ pct: 140 }), 10).percent).toBe(100)
  })
})
