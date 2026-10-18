import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import { activateSystemEmojiFont, findSystemEmojiFont, registerFonts } from '../../src/core/render/fonts'
import { renderOverlayAssets } from '../../src/core/render/overlay'
import { resolveLayout } from '../../src/shared/layout/engine'
import { FONTS_DIR, loadFont, loadHookTemplate } from '../helpers/env'

/**
 * Emoji in hooks must survive the burn-in: Skia has no automatic system-font
 * fallback, so the overlay needs the platform emoji font registered and listed
 * in canvasFontSpec. The maple leaf is red — saturated pixels that the white
 * Inter text (and black background) can never produce are its fingerprint.
 */

const template = loadHookTemplate()

function overlayFor(hook: string): PNG {
  const layout = resolveLayout({
    template,
    values: { fields: { hook }, knobs: {} },
    clip: { width: 1920, height: 1080 },
    loadFont
  })
  return PNG.sync.read(renderOverlayAssets(layout).overlayPng)
}

/** Pixels whose channels spread wide enough to rule out white/black/gray ink. */
function saturatedPixelCount(png: PNG): number {
  let count = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i] as number
    const g = png.data[i + 1] as number
    const b = png.data[i + 2] as number
    if (png.data[i + 3]! > 0 && Math.max(r, g, b) - Math.min(r, g, b) > 40) count += 1
  }
  return count
}

describe.skipIf(findSystemEmojiFont() === null)('overlay emoji rendering', () => {
  it('renders a hook emoji in color once the system emoji font is active', () => {
    registerFonts(FONTS_DIR)

    // Control: without activation the emoji renders blank (the old behavior).
    const before = saturatedPixelCount(overlayFor('MAPLE 🍁 LEAF'))
    expect(before).toBe(0)

    expect(activateSystemEmojiFont()).not.toBeNull()
    const after = saturatedPixelCount(overlayFor('MAPLE 🍁 LEAF'))
    // A ~100px maple leaf is thousands of colored pixels; 200 leaves headroom
    // for anti-aliasing while proving the glyph actually rasterized.
    expect(after).toBeGreaterThan(200)
  })
})
