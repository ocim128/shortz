import { describe, expect, it } from 'vitest'
import { formatBytes, formatFps, formatTime } from '../../src/renderer/src/lib/format'

describe('formatTime', () => {
  it('renders m:ss with zero padding', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(7.2)).toBe('0:07')
    expect(formatTime(65.4)).toBe('1:05')
    expect(formatTime(-3)).toBe('0:00')
  })
})

describe('formatBytes', () => {
  it('renders human sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('formatFps — canonical snapping (NTSC-aware)', () => {
  it('displays the exact NTSC rate for 24000/1001 float noise', () => {
    expect(formatFps(24000 / 1001)).toBe('23.976') // 23.976023…
  })

  it('recovers 23.976 from legacy two-decimal snapshots (23.98)', () => {
    expect(formatFps(23.98)).toBe('23.976')
  })

  it('handles 30000/1001 and 60000/1001', () => {
    expect(formatFps(30000 / 1001)).toBe('29.97') // 29.970029…
    expect(formatFps(29.97)).toBe('29.97')
    expect(formatFps(60000 / 1001)).toBe('59.94') // 59.940059…
  })

  it('keeps integer rates integer', () => {
    expect(formatFps(24)).toBe('24')
    expect(formatFps(30)).toBe('30')
    expect(formatFps(60)).toBe('60')
  })

  it('falls back to 3-decimal precision for unusual rates', () => {
    expect(formatFps(23.5)).toBe('23.5')
    expect(formatFps(26.23456)).toBe('26.235')
  })

  it('returns empty for non-finite input', () => {
    expect(formatFps(0)).toBe('')
    expect(formatFps(Number.NaN)).toBe('')
  })
})
