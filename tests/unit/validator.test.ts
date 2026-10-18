import { describe, expect, it } from 'vitest'
import { describeTemplateIssues, validateTemplate } from '../../src/shared/template/validate'
import { loadHookTemplate, readJson, TEMPLATES_DIR } from '../helpers/env'
import path from 'node:path'

function hookRaw(): Record<string, unknown> {
  return readJson(path.join(TEMPLATES_DIR, 'hook-letterbox.json')) as Record<string, unknown>
}

function issuesOf(raw: unknown): { path: string; message: string }[] {
  const result = validateTemplate(raw)
  expect(result.ok).toBe(false)
  return result.ok ? [] : result.issues
}

describe('validateTemplate', () => {
  it('accepts the bundled hook-letterbox template', () => {
    const result = validateTemplate(hookRaw())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.template.id).toBe('hook-letterbox')
      expect(result.template.canvas.width).toBe(1080)
      expect(result.template.slots).toHaveLength(2)
    }
  })

  it('rejects non-objects and wrong schema versions', () => {
    expect(issuesOf('nope').length).toBeGreaterThan(0)
    const raw = hookRaw()
    raw.schemaVersion = 2
    expect(issuesOf(raw).some((i) => i.path === 'schemaVersion')).toBe(true)
  })

  it('flags duplicate slot ids and duplicate input keys', () => {
    const raw = hookRaw()
    const slots = raw.slots as Record<string, unknown>[]
    slots[1]!.id = 'video'
    const inputs = raw.inputs as Record<string, unknown>[]
    inputs.push({ ...inputs[0] })
    const issues = issuesOf(raw)
    expect(issues.some((i) => i.message.includes('duplicate slot id'))).toBe(true)
    expect(issues.some((i) => i.message.includes('duplicate input key'))).toBe(true)
  })

  it('requires exactly one video slot in v1', () => {
    const raw = hookRaw()
    const slots = raw.slots as Record<string, unknown>[]
    slots.push(structuredClone(slots[0]!))
    const issues = issuesOf(raw)
    expect(issues.some((i) => i.message.includes('exactly one video slot'))).toBe(true)
  })

  it('rejects unknown knob ids and invalid knob defaults', () => {
    const raw = hookRaw()
    const knobs = raw.knobs as Record<string, unknown>[]
    knobs.push({ id: 'rotationSpeed', label: 'Spin', control: 'slider', default: 9 })
    const issues = issuesOf(raw)
    expect(issues.some((i) => i.path.endsWith('.id') && i.message.includes('rotationSpeed'))).toBe(
      true
    )
  })

  it('requires text slots to bind to a declared input', () => {
    const raw = hookRaw()
    const slots = raw.slots as Record<string, unknown>[]
    slots[1]!.bindsTo = 'missing'
    const issues = issuesOf(raw)
    expect(issues.some((i) => i.message.includes('no input with key "missing"'))).toBe(true)
  })

  it('enforces the >=120px aboveVideo room rule at the default videoTop', () => {
    const raw = hookRaw()
    const slots = raw.slots as Record<string, unknown>[]
    ;(slots[1]!.anchor as Record<string, unknown>).minY = 400
    const issues = issuesOf(raw)
    expect(issues.some((i) => i.message.includes('aboveVideo room'))).toBe(true)
  })

  it('formats issues for logs', () => {
    const text = describeTemplateIssues([
      { path: 'canvas.width', message: 'expected a positive number' }
    ])
    expect(text).toContain('canvas.width')
    expect(text).toContain('expected a positive number')
  })
})

describe('bundled template sanity', () => {
  it('loads and exposes the expected knob surface', () => {
    const template = loadHookTemplate()
    expect(template.knobs.map((k) => k.id)).toEqual([
      'backgroundStyle',
      'videoTop',
      'videoCornerRadius',
      'textAlign'
    ])
    expect(template.inputs[0]!.key).toBe('hook')
  })
})
