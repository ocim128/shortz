import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFontBufferLoader, fontLoaderCount } from '../../src/core/render/fonts'
import { loadTemplateById } from '../../src/core/store/templates'
import { resolveLayout } from '../../src/shared/layout/engine'
import { clearFontCache, fontCacheSize } from '../../src/shared/layout/text'

const resourcesDir = path.resolve('resources')
const fontsDir = path.join(resourcesDir, 'fonts')

describe('createFontBufferLoader — one loader identity per directory', () => {
  it('returns the same loader for the same directory (trailing slash included)', () => {
    const first = createFontBufferLoader(fontsDir)
    const second = createFontBufferLoader(`${fontsDir}${path.sep}`)
    expect(second).toBe(first)
    expect(fontLoaderCount()).toBeGreaterThan(0)
  })

  it('keeps the shared metrics cache warm across renders', async () => {
    const template = await loadTemplateById(resourcesDir, 'hook-letterbox')
    clearFontCache()
    const before = fontLoaderCount()

    for (let i = 0; i < 3; i += 1) {
      resolveLayout({
        template,
        values: { fields: { hook: 'Repeated render, same fonts' }, knobs: {} },
        clip: { width: 1920, height: 1080, durationSec: 30 },
        loadFont: createFontBufferLoader(fontsDir)
      })
    }

    // One loader identity => one parsed-font set, not one per render.
    expect(fontCacheSize()).toBe(1)
    expect(fontLoaderCount()).toBe(before)
  })
})
