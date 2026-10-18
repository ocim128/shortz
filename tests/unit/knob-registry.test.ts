import { describe, expect, it } from 'vitest'
import {
  KNOB_IDS,
  KNOB_REGISTRY,
  resolveKnobValues,
  validateKnobValue
} from '../../src/shared/template/knob-registry'

describe('KNOB_REGISTRY', () => {
  it('exposes the documented defaults from the schema doc', () => {
    expect(KNOB_REGISTRY.backgroundStyle.default).toBe('black')
    expect(KNOB_REGISTRY.videoTop.default).toBe(520)
    expect(KNOB_REGISTRY.videoCornerRadius.default).toBe(24)
    expect(KNOB_REGISTRY.videoScale.default).toBe(1)
    expect(KNOB_REGISTRY.textAlign.default).toBe('left')
    expect(KNOB_REGISTRY.textFont.default).toBe('inter')
    expect(KNOB_REGISTRY.textMaxLines.default).toBe(4)
    expect(KNOB_IDS).toHaveLength(8)
  })
})

describe('validateKnobValue', () => {
  it('enforces ranges for numeric knobs', () => {
    expect(validateKnobValue('videoTop', 520)).toBeNull()
    expect(validateKnobValue('videoTop', 400)).toMatch(/>=/)
    expect(validateKnobValue('videoTop', 900)).toMatch(/<=/)
    expect(validateKnobValue('videoTop', 'tall')).toMatch(/number/)
  })

  it('enforces option lists for string knobs', () => {
    expect(validateKnobValue('backgroundStyle', 'blurVideo')).toBeNull()
    expect(validateKnobValue('backgroundStyle', 'pink')).toMatch(/one of/)
    expect(validateKnobValue('textAlign', 3)).toMatch(/string/)
  })
})

describe('resolveKnobValues', () => {
  it('starts from registry defaults', () => {
    const { values, warnings } = resolveKnobValues([], undefined)
    expect(warnings).toEqual([])
    expect(values).toMatchObject({ backgroundStyle: 'black', videoTop: 520, videoScale: 1 })
  })

  it('lets template knob defaults override registry defaults', () => {
    const { values } = resolveKnobValues(
      [{ id: 'videoTop', label: 'pos', control: 'slider', default: 600, min: 480, max: 700 }],
      undefined
    )
    expect(values.videoTop).toBe(600)
  })

  it('applies valid user overrides and warns on invalid ones', () => {
    const { values, warnings } = resolveKnobValues(
      [{ id: 'videoTop', label: 'pos', control: 'slider', default: 600 }],
      { videoTop: 480, backgroundStyle: 'magenta' }
    )
    expect(values.videoTop).toBe(480)
    expect(values.backgroundStyle).toBe('black')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('backgroundStyle')
  })

  it('warns on unknown knob ids and ignores them', () => {
    const { warnings } = resolveKnobValues([], { rotationSpeed: 9 } as never)
    expect(warnings.some((w) => w.includes('rotationSpeed'))).toBe(true)
  })
})
