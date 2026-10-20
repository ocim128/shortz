/**
 * Quality policy — which variant of one media asset gets downloaded.
 *
 * Pure and deterministic (docs/twitter-downloader/03-tech-stack.md §"Quality
 * selection"): a ladder that lies must not decide the winner by accident. The
 * audit's rev-2 finding was that `b.bitrate - a.bitrate` yields `NaN` when
 * bitrate is `null` (fxtwitter) or `0` (some GIF variants), and V8's sort order
 * with NaN is implementation-defined. So every comparison goes through
 * {@link variantScore}, which never returns NaN.
 */

import type { Chosen, DlQuality, MediaAsset, ResolvedTweet, Variant } from './types'

/** Variants that are actually downloadable by our engine (progressive, not HLS). */
function isProgressive(variant: Variant): boolean {
  const type = variant.contentType
  if (type === null) return true
  const lower = type.toLowerCase()
  if (lower.includes('mpegurl') || lower.includes('m3u8')) return false
  return lower.startsWith('video/') || lower === 'application/octet-stream'
}

/**
 * Never NaN: a positive bitrate, else pixel area. `0` and `null` both fall through
 * to the area — a 0-bitrate GIF ladder still orders by dimensions.
 */
export function variantScore(variant: Variant, asset?: MediaAsset): number {
  if (variant.bitrate !== null && variant.bitrate > 0) return variant.bitrate
  return effectiveWidth(variant, asset) * effectiveHeight(variant, asset)
}

function effectiveWidth(variant: Variant, asset?: MediaAsset): number {
  return variant.width ?? asset?.width ?? 0
}

function effectiveHeight(variant: Variant, asset?: MediaAsset): number {
  return variant.height ?? asset?.height ?? 0
}

/**
 * Total, order-independent orders. `best` runs score-descending with the URL as
 * an *ascending* tie-break (the doc's "lexicographic URL compare"); `worst` runs
 * score-ascending. Reversing the candidate list can therefore never change the
 * answer — the property the audit's NaN finding was really about.
 */
function compareBest(a: Variant, b: Variant, asset: MediaAsset): number {
  const scoreDiff = variantScore(b, asset) - variantScore(a, asset)
  if (scoreDiff !== 0) return scoreDiff
  const areaDiff =
    effectiveWidth(b, asset) * effectiveHeight(b, asset) -
    effectiveWidth(a, asset) * effectiveHeight(a, asset)
  if (areaDiff !== 0) return areaDiff
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0
}

function compareWorst(a: Variant, b: Variant, asset: MediaAsset): number {
  const scoreDiff = variantScore(a, asset) - variantScore(b, asset)
  if (scoreDiff !== 0) return scoreDiff
  const areaDiff =
    effectiveWidth(a, asset) * effectiveHeight(a, asset) -
    effectiveWidth(b, asset) * effectiveHeight(b, asset)
  if (areaDiff !== 0) return areaDiff
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0
}

function heightOf(variant: Variant, asset: MediaAsset): number | null {
  const height = variant.height ?? asset.height
  return height === null || height <= 0 ? null : height
}

function pickBest(candidates: Variant[], asset: MediaAsset): Variant {
  return [...candidates].sort((a, b) => compareBest(a, b, asset))[0] as Variant
}

function pickWorst(candidates: Variant[], asset: MediaAsset): Variant {
  return [...candidates].sort((a, b) => compareWorst(a, b, asset))[0] as Variant
}

/**
 * `maxHeight`: height distance to the cap dominates (the closest fit **from
 * below**; when every variant is above the cap, the closest fit **from above** —
 * never an error, xdl decision #5), then the usual score, then the URL.
 */
function pickMaxHeight(candidates: Variant[], asset: MediaAsset, cap: number): Variant {
  const withHeight = candidates.filter((variant) => heightOf(variant, asset) !== null)
  if (withHeight.length === 0) return pickBest(candidates, asset)

  const distance = (variant: Variant): number => (heightOf(variant, asset) as number) - cap
  const under = withHeight.filter((variant) => distance(variant) <= 0)
  const closestAbove = Math.min(...withHeight.map((variant) => distance(variant)))
  const pool =
    under.length > 0 ? under : withHeight.filter((variant) => distance(variant) === closestAbove)

  return [...pool].sort((a, b) => {
    const scoreDiff = variantScore(b, asset) - variantScore(a, asset)
    if (scoreDiff !== 0) return scoreDiff
    const distanceDiff = Math.abs(distance(a)) - Math.abs(distance(b))
    if (distanceDiff !== 0) return distanceDiff
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0
  })[0] as Variant
}

/**
 * One asset → one chosen variant, or null when nothing is downloadable
 * (photo-only post, no progressive variant).
 */
export function selectVariant(asset: MediaAsset, quality: DlQuality): Chosen | null {
  if (asset.kind === 'photo') return null
  const candidates = asset.variants.filter(
    (variant) => typeof variant.url === 'string' && variant.url.length > 0 && isProgressive(variant)
  )
  if (candidates.length === 0) return null

  let variant: Variant
  if (quality === 'worst') {
    variant = pickWorst(candidates, asset)
  } else if (quality === 'best') {
    variant = pickBest(candidates, asset)
  } else {
    variant = pickMaxHeight(candidates, asset, quality.maxHeight)
  }
  return { index: asset.index, media: asset, variant }
}

/** Every video/GIF asset of a post, in post order. Photos are never downloaded. */
export function selectAllChosen(resolved: ResolvedTweet, quality: DlQuality): Chosen[] {
  const chosen: Chosen[] = []
  for (const asset of resolved.media) {
    const one = selectVariant(asset, quality)
    if (one !== null) chosen.push(one)
  }
  return chosen
}
