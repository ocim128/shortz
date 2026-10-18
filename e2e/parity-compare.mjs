// Pixel comparison for the preview↔render parity check (called by e2e/parity.mjs).
//
//   node e2e/parity-compare.mjs <preview.png> <render.png> [inset]
//
// Prints JSON: overall + per-band mean absolute channel error (0–255) and the
// share of pixels differing by more than 24/255. Bands follow the hook-letterbox
// geometry in 390×693 preview space: hook text above the video, video below,
// background = everything else (letterbox margins around the video).

import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const [, , previewPath, renderPath, insetArg] = process.argv
if (!previewPath || !renderPath) {
  console.error('usage: parity-compare.mjs <preview.png> <render.png> [inset]')
  process.exit(2)
}
const inset = Number(insetArg ?? '0')

const a = PNG.sync.read(readFileSync(previewPath))
const b = PNG.sync.read(readFileSync(renderPath))

if (a.width !== b.width || a.height !== b.height) {
  // Compare in the render's own space: resize is done by the caller (parity.mjs
  // scales the render to 390×693). Mismatch means the caller drifted.
  console.error(`size mismatch: preview ${a.width}x${a.height} vs render ${b.width}x${b.height}`)
  process.exit(2)
}

const W = a.width
const H = a.height

// Design-space geometry of the shipped template, scaled into preview space.
const SCALE = W / 1080
const videoTop = Math.round(520 * SCALE)
const videoBottom = Math.round(1128 * SCALE)

function bandFor(y) {
  if (y >= videoTop && y < videoBottom) return 'video'
  if (y < videoTop) return 'text'
  return 'background'
}

function empty() {
  return { n: 0, sum: 0, over: 0 }
}
const overall = empty()
const bands = { text: empty(), video: empty(), background: empty() }

for (let y = inset; y < H - inset; y += 1) {
  for (let x = inset; x < W - inset; x += 1) {
    const i = (y * W + x) * 4
    // Ignore alpha; screenshots are opaque but be explicit.
    const dr = Math.abs(a.data[i] - b.data[i])
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1])
    const db = Math.abs(a.data[i + 2] - b.data[i + 2])
    const err = (dr + dg + db) / 3
    const band = bands[bandFor(y)]
    for (const target of [overall, band]) {
      target.n += 1
      target.sum += err
      if (err > 24) target.over += 1
    }
  }
}

function finish(t) {
  return t.n === 0
    ? { pixels: 0, mae: null, over24: null }
    : { pixels: t.n, mae: round(t.sum / t.n), over24: round(t.over / t.n) }
}
function round(v) {
  return Math.round(v * 1000) / 1000
}

/**
 * Ink coverage per band — guards against a vacuous comparison. If either image
 * were mostly empty (a blank phone frame, a failed screenshot clip), band MAE
 * would look excellent while proving nothing. Both sides must show real text
 * ink above the video and lit pixels in the video band.
 */
function coverage(img, yFrom, yTo, threshold) {
  let hit = 0
  let total = 0
  for (let y = Math.max(inset, yFrom); y < Math.min(H - inset, yTo); y += 1) {
    for (let x = inset; x < W - inset; x += 1) {
      const i = (y * W + x) * 4
      const lum = img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114
      if (lum > threshold) hit += 1
      total += 1
    }
  }
  return total === 0 ? 0 : round(hit / total)
}

const ink = {
  text: { preview: coverage(a, 0, videoTop, 128), render: coverage(b, 0, videoTop, 128) },
  video: { preview: coverage(a, videoTop, videoBottom, 40), render: coverage(b, videoTop, videoBottom, 40) }
}

console.log(
  JSON.stringify(
    {
      size: { width: W, height: H },
      inset,
      bands: { text: finish(bands.text), video: finish(bands.video), background: finish(bands.background) },
      ink,
      overall: finish(overall)
    },
    null,
    2
  )
)
