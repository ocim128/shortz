import { describe, expect, it } from 'vitest'
import { LayoutError, resolveLayout, type ResolveLayoutInput } from '../../src/shared/layout/engine'
import type { KnobId } from '../../src/shared/template/knob-registry'
import type { Template } from '../../src/shared/template/types'
import { loadFont, loadHookTemplate } from '../helpers/env'

function resolve(
  clip: { width: number; height: number },
  overrides: { hook?: string; knobs?: Partial<Record<KnobId, unknown>> } = {}
): ReturnType<typeof resolveLayout> {
  const template = loadHookTemplate()
  return resolveLayout({
    template,
    values: {
      fields: { hook: overrides.hook ?? 'Hello world' },
      knobs: overrides.knobs ?? {}
    },
    clip,
    loadFont
  })
}

describe('resolveLayout — video geometry', () => {
  it('letterboxes 16:9 to 1080x608 at y 520 (normative example)', () => {
    const layout = resolve({ width: 1920, height: 1080 })
    expect(layout.video).toMatchObject({ x: 0, y: 520, w: 1080, h: 608, cornerRadius: 24 })
    expect(layout.canvas).toMatchObject({ width: 1080, height: 1920, background: 'black' })
  })

  it('pillarboxes a rotation-normalized portrait clip to 551x980, centered', () => {
    const layout = resolve({ width: 1080, height: 1920 })
    expect(layout.video).toMatchObject({ x: 265, y: 520, w: 551, h: 980 })
  })

  it('gives a 4:3 clip a full-width 1080x810 box', () => {
    const layout = resolve({ width: 640, height: 480 })
    expect(layout.video).toMatchObject({ x: 0, y: 520, w: 1080, h: 810 })
  })

  it('applies a declared videoTop knob by moving the bounded box', () => {
    const layout = resolve({ width: 1920, height: 1080 }, { knobs: { videoTop: 700 } })
    expect(layout.video.y).toBe(700)
  })

  it('ignores knobs the template does not declare', () => {
    // videoScale is in the registry but absent from the hook-letterbox knobs list.
    const layout = resolve({ width: 1920, height: 1080 }, { knobs: { videoScale: 0.5 } })
    expect(layout.video).toMatchObject({ x: 0, y: 520, w: 1080, h: 608 })
  })

  it('scales and centers the box when the template declares videoScale', () => {
    const template: Template = structuredClone(loadHookTemplate())
    template.knobs.push({
      id: 'videoScale',
      label: 'Video scale',
      control: 'slider',
      default: 1,
      min: 0.85,
      max: 1,
      step: 0.01
    })
    const layout = resolveLayout({
      template,
      values: { fields: { hook: 'Hello world' }, knobs: { videoScale: 0.9 } },
      clip: { width: 1920, height: 1080 },
      loadFont
    })
    // box 972x882 at y 569; 16:9 contained -> 972x547 at x 54.
    expect(layout.video).toMatchObject({ x: 54, y: 569, w: 972, h: 547 })
  })
})

describe('resolveLayout — text', () => {
  it('anchors the hook block above the video with the configured gap', () => {
    const layout = resolve({ width: 1920, height: 1080 })
    expect(layout.texts).toHaveLength(1)
    const hook = layout.texts[0]!
    expect(hook.slotId).toBe('hook')
    expect(hook.lines).toEqual(['Hello world'])
    expect(hook.fontKey).toBe('inter-600')
    expect(hook.fontSize).toBe(68)
    expect(hook.lineHeightPx).toBe(85)
    // 520 (video top) - 32 (gap) - 85 (block) = 403
    expect(hook.y).toBe(403)
    expect(hook.ascentPx).toBeGreaterThan(0)
  })

  it('treats whitespace-only required text as missing-input', () => {
    const template = loadHookTemplate()
    try {
      resolveLayout({
        template,
        values: { fields: { hook: '   ' }, knobs: {} },
        clip: { width: 1920, height: 1080 },
        loadFont
      })
      expect.unreachable('expected LayoutError')
    } catch (error) {
      expect(error).toBeInstanceOf(LayoutError)
      expect((error as LayoutError).code).toBe('missing-input')
    }
  })

  it('skips the text slot when an optional field is empty', () => {
    const template: Template = structuredClone(loadHookTemplate())
    template.inputs[0]!.required = false
    const layout = resolveLayout({
      template,
      values: { fields: {}, knobs: {} },
      clip: { width: 1920, height: 1080 },
      loadFont
    })
    expect(layout.texts).toHaveLength(0)
  })

  it('clamps to minY and warns when the block is too tall', () => {
    const template = loadHookTemplate()
    const long =
      'A wildlife photographer put a microphone beside a baby squirrel and this is what happened next'
    const layout = resolveLayout({
      template,
      values: { fields: { hook: long }, knobs: {} },
      clip: { width: 1920, height: 1080 },
      loadFont
    })
    const hook = layout.texts[0]!
    expect(hook.lines.length).toBeGreaterThan(1)
    const naturalTop = 520 - 32 - hook.lines.length * hook.lineHeightPx
    if (naturalTop < 150) {
      expect(hook.y).toBe(150)
      expect(layout.warnings.some((w) => w.includes('clamped'))).toBe(true)
    } else {
      expect(hook.y).toBe(Math.round(naturalTop))
    }
  })
})

describe('resolveLayout — background knobs and errors', () => {
  it('switches to blurred-video background through the declared knob', () => {
    const layout = resolve(
      { width: 1920, height: 1080 },
      { knobs: { backgroundStyle: 'blurVideo' } }
    )
    expect(layout.canvas.background).toBe('blurVideo')
    expect(layout.canvas.blur).toEqual({ sigma: 30, darken: 0.05 })
  })

  it('throws missing-input when a required field is empty', () => {
    const template = loadHookTemplate()
    try {
      resolveLayout({
        template,
        values: { fields: {}, knobs: {} },
        clip: { width: 1920, height: 1080 },
        loadFont
      })
      expect.unreachable('expected LayoutError')
    } catch (error) {
      expect(error).toBeInstanceOf(LayoutError)
      expect((error as LayoutError).code).toBe('missing-input')
      expect((error as LayoutError).slotId).toBe('hook')
    }
  })

  it('throws text-too-long when the copy cannot fit even at the floor size', () => {
    const template = loadHookTemplate()
    const huge = 'endless words '.repeat(60)
    try {
      resolveLayout({
        template,
        values: { fields: { hook: huge }, knobs: {} },
        clip: { width: 1920, height: 1080 },
        loadFont
      })
      expect.unreachable('expected LayoutError')
    } catch (error) {
      expect(error).toBeInstanceOf(LayoutError)
      expect((error as LayoutError).code).toBe('text-too-long')
    }
  })

  it('exposes the resolved layout type surface used by the renderer', () => {
    const layout = resolve({ width: 1920, height: 1080 })
    const input: ResolveLayoutInput = {
      template: loadHookTemplate(),
      values: { fields: { hook: 'x' }, knobs: {} },
      clip: { width: 1920, height: 1080 },
      loadFont
    }
    expect(typeof input.template.id).toBe('string')
    expect(layout.warnings).toBeInstanceOf(Array)
  })
})

describe('resolveLayout — emptyRequired: skip-slot (preview mode)', () => {
  it('resolves with the slot omitted and a warning when a required field is empty', () => {
    const template = loadHookTemplate()
    const layout = resolveLayout({
      template,
      values: { fields: {}, knobs: {} },
      clip: { width: 1920, height: 1080 },
      loadFont,
      emptyRequired: 'skip-slot'
    })
    // The video geometry must survive — an empty hook can never blank it.
    expect(layout.video).toMatchObject({ x: 0, y: 520, w: 1080, h: 608 })
    expect(layout.texts).toHaveLength(0)
    expect(layout.warnings.some((w) => w.includes('"hook"') && w.includes('required'))).toBe(true)
  })

  it('treats whitespace-only as empty in skip-slot mode too', () => {
    const template = loadHookTemplate()
    const layout = resolveLayout({
      template,
      values: { fields: { hook: '   ' }, knobs: {} },
      clip: { width: 1920, height: 1080 },
      loadFont,
      emptyRequired: 'skip-slot'
    })
    expect(layout.texts).toHaveLength(0)
    expect(layout.warnings.some((w) => w.includes('"hook"'))).toBe(true)
  })

  it('resolves non-empty values identically in both modes (preview cannot diverge from export)', () => {
    const template = loadHookTemplate()
    const values = { fields: { hook: 'Hello world' }, knobs: { videoTop: 600 } }
    const clip = { width: 1280, height: 720 }
    const strict = resolveLayout({ template, values, clip, loadFont })
    const lenient = resolveLayout({ template, values, clip, loadFont, emptyRequired: 'skip-slot' })
    expect(lenient).toEqual(strict)
  })

  it('still throws text-too-long in skip-slot mode (only required-empty is forgiven)', () => {
    const template = loadHookTemplate()
    const huge = 'endless words '.repeat(60)
    try {
      resolveLayout({
        template,
        values: { fields: { hook: huge }, knobs: {} },
        clip: { width: 1920, height: 1080 },
        loadFont,
        emptyRequired: 'skip-slot'
      })
      expect.unreachable('expected LayoutError')
    } catch (error) {
      expect(error).toBeInstanceOf(LayoutError)
      expect((error as LayoutError).code).toBe('text-too-long')
    }
  })
})

describe('resolveLayout — videoFraming (smart sizing)', () => {
  it('letterbox (default) keeps the normative contain geometry and fit flag', () => {
    const layout = resolve({ width: 1920, height: 1080 })
    expect(layout.video).toMatchObject({ x: 0, y: 520, w: 1080, h: 608, fit: 'contain' })
  })

  it('fill cover-fills the safe box exactly — no letterbox band inside the box', () => {
    const layout = resolve({ width: 1920, height: 1080 }, { knobs: { videoFraming: 'fill' } })
    expect(layout.video).toMatchObject({ x: 0, y: 520, w: 1080, h: 980, fit: 'cover' })
  })

  it('smart never crops: the whole clip stays contained and the dead space goes blurred', () => {
    const wide = resolve({ width: 1920, height: 1080 }, { knobs: { videoFraming: 'auto' } })
    expect(wide.video).toMatchObject({ x: 0, y: 520, w: 1080, h: 608, fit: 'contain' })
    expect(wide.canvas.background).toBe('blurVideo')
    expect(wide.canvas.blur).toEqual({ sigma: 30, darken: 0.05 })
    const tall = resolve({ width: 1080, height: 1920 }, { knobs: { videoFraming: 'auto' } })
    expect(tall.video).toMatchObject({ x: 265, y: 520, w: 551, h: 980, fit: 'contain' })
    expect(tall.canvas.background).toBe('blurVideo')
  })

  it('an explicitly chosen Background wins over smart\u2019s blur fill', () => {
    const layout = resolve(
      { width: 1920, height: 1080 },
      { knobs: { videoFraming: 'auto', backgroundStyle: 'white' } }
    )
    expect(layout.canvas.background).toBe('white')
    expect(layout.video.fit).toBe('contain')
  })

  it('fill honours the videoTop knob and clips warnings stay silent', () => {
    const layout = resolve({ width: 1920, height: 1080 }, { knobs: { videoFraming: 'fill', videoTop: 700 } })
    expect(layout.video).toMatchObject({ y: 700, w: 1080, h: 980 })
    expect(layout.warnings).toEqual([])
  })

  it('a template without the knob falls back to its slot fit (cover now honored)', () => {
    const template = loadHookTemplate()
    template.knobs = template.knobs.filter((k) => k.id !== 'videoFraming')
    const slot = template.slots.find((s) => s.type === 'video')
    if (slot && slot.type === 'video') slot.fit = 'cover'
    const layout = resolveLayout({
      template,
      values: { fields: { hook: 'Hello world' }, knobs: {} },
      clip: { width: 1920, height: 1080 },
      loadFont
    })
    expect(layout.video).toMatchObject({ w: 1080, h: 980, fit: 'cover' })
    // The v1 "renders as contain" warning is gone.
    expect(layout.warnings.join(' ')).not.toContain('cover')
  })
})
