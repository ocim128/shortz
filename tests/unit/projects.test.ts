import { describe, expect, it } from 'vitest'
import { ulid } from 'ulid'
import { assertProjectId, isProjectId, PROJECT_ID_RE } from '../../src/core/store/projects'

describe('project id guard', () => {
  it('accepts every id the app mints (ulid)', () => {
    for (let i = 0; i < 100; i += 1) {
      const id = ulid()
      expect(isProjectId(id)).toBe(true)
      expect(() => assertProjectId(id)).not.toThrow()
    }
  })

  it('rejects traversal, absolute, lowercase, wrong-length and non-string ids', () => {
    const bad: unknown[] = [
      '../../../evil',
      '..\\..\\..\\evil',
      'C:\\Users\\evil',
      '',
      '01h' + 'a'.repeat(23), // lowercase — ULIDs are uppercase
      ulid().slice(0, 25), // too short
      ulid() + '0', // too long
      42,
      null,
      undefined,
      { id: ulid() }
    ]
    for (const id of bad) {
      expect(isProjectId(id)).toBe(false)
      expect(() => assertProjectId(id)).toThrow(/Invalid project id/)
    }
  })

  it('excludes the non-Crockford letters I L O U', () => {
    // A 26-char id containing a letter outside the Base32 alphabet must fail.
    expect(PROJECT_ID_RE.test('I'.repeat(26))).toBe(false)
    expect(PROJECT_ID_RE.test('L'.repeat(26))).toBe(false)
    expect(PROJECT_ID_RE.test('O'.repeat(26))).toBe(false)
    expect(PROJECT_ID_RE.test('U'.repeat(26))).toBe(false)
    expect(PROJECT_ID_RE.test('7AR'.repeat(8) + 'QQ')).toBe(true)
  })
})
