import { describe, expect, it } from 'vitest'
import { syndicationToken } from '../../../src/shared/downloader/token'

/**
 * Golden vectors from docs/twitter-downloader/technical/resolver-chain.md §2 —
 * regenerated on Node ≥ 20 and re-verified here. The generator one-liner is
 * committed next to them in `token.ts`:
 *
 *   node -e "const t=i=>((Number(i)/1e15)*Math.PI).toString(36).replace(/(0+|\.)/g,'');console.log(t('20'))"
 *
 * D-A20: if a vector fails, the IMPLEMENTATION is wrong — never "fix" a vector
 * to match a hand computation. (A previously prose-quoted `"20" → "6dq1a2xwd9"`
 * had lost its trailing digit; the true value is `6dq1a2xwd93`.)
 */
const GOLDENS: ReadonlyArray<readonly [string, string]> = [
  ['20', '6dq1a2xwd93'],
  ['21', '6p7jcdvzsb'],
  ['123456789012345678', 'arumtis9w99'],
  ['1750123456789012352', '48q6asjxr3'],
  ['1799999999999999999', '4d2v7cbm2xj'],
  ['100', 'vwm6eephu8'],
  ['12345', '31esng3xq8a'],
  ['5639204740561071959', 'do4313qj6b'],
  ['5895164605079987165', 'eag7eqi7c2m'],
  ['6121601747147618504', 'eu7kuhf2awe'],
  ['6372485000959720218', 'fg3r2oaxtge'],
  ['6595826540000181755', 'fzleenudshf'],
  ['6817747400060980518', 'giyl2ckost'],
  ['7045075807784168866', 'h2sravznr6'],
  ['7299418402012119495', 'hozsrsqux8'],
  ['7540523709986053373', 'ia1951k8u8a'],
  ['7785376654501314647', 'ivehct9lfa']
]

describe('syndicationToken', () => {
  it.each(GOLDENS)('id %s -> %s', (tweetId, token) => {
    expect(syndicationToken(tweetId)).toBe(token)
  })

  it('produces the same value for every id in the golden table twice (pure)', () => {
    for (const [id] of GOLDENS) {
      expect(syndicationToken(id)).toBe(syndicationToken(id))
    }
  })

  it('never emits the radix point or a zero run', () => {
    for (let id = 1000; id < 1100; id += 1) {
      const token = syndicationToken(String(id))
      expect(token.length).toBeGreaterThan(0)
      expect(token).not.toContain('.')
      expect(token).not.toMatch(/0/)
    }
  })

  it('is lossy above 2^53 by design (byte-exactness, not arithmetic)', () => {
    // Number('1799999999999999999') rounds; the endpoint expects exactly this token.
    expect(syndicationToken('1799999999999999999')).toBe('4d2v7cbm2xj')
    // Two distinct 16-digit ids collapse onto the same double — that collision is
    // the documented behaviour, not a bug to "fix".
    expect(syndicationToken('9007199254740993')).toBe(syndicationToken('9007199254740992'))
    expect(syndicationToken('1000')).not.toBe(syndicationToken('2000'))
  })
})
