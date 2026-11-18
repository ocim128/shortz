import { describe, expect, it } from 'vitest'
import { gecTicks, secMsGec } from '../../src/core/tts/net/gec'

// 2026-11-18T10:07:33Z — mid-bucket; the bucket starts at 10:05:00Z.
const MID_BUCKET = new Date('2026-11-18T10:07:33Z')
const ON_BUCKET = new Date('2026-11-18T10:05:00Z')

describe('gecTicks (Sec-MS-GEC bucket math)', () => {
  it('floors the Windows file time to the 5-minute bucket', () => {
    expect(gecTicks(MID_BUCKET)).toBe('134394699000000000')
  })

  it('leaves a time already on the bucket boundary unchanged', () => {
    expect(gecTicks(ON_BUCKET)).toBe(gecTicks(MID_BUCKET))
  })
})

describe('secMsGec (v2, CS64-SHA256)', () => {
  it('produces the documented <CS64 hex16>-<SHA256 hex64> shape', () => {
    expect(secMsGec(MID_BUCKET)).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/)
  })

  it('is stable within a bucket and changes when the bucket changes', () => {
    expect(secMsGec(MID_BUCKET)).toBe(secMsGec(ON_BUCKET))
    expect(secMsGec(MID_BUCKET)).not.toBe(secMsGec(new Date('2026-11-18T10:12:00Z')))
  })
})
