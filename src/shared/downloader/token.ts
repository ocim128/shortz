/**
 * The syndication token (docs/twitter-downloader/technical/resolver-chain.md §2).
 *
 * react-tweet's getToken, byte-exact because BOTH sides run V8's
 * DoubleToRadixStringView: ((Number(id) / 1e15) * Math.PI).toString(36),
 * then strip zero-runs and the radix point. Do not "improve" the precision:
 * Number(id) is lossy above 2^53 by design — the endpoint expects exactly this.
 *
 * Generator for the golden table in `tests/unit/downloader/token.test.ts`:
 *   node -e "const t=i=>((Number(i)/1e15)*Math.PI).toString(36).replace(/(0+|\.)/g,'');console.log(t('20'))"
 */
export function syndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}
