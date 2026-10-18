import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertTemplateId, isTemplateId, loadTemplateById } from '../../src/core/store/templates'

describe('template id containment', () => {
  it('accepts slug ids', () => {
    expect(isTemplateId('hook-letterbox')).toBe(true)
    expect(isTemplateId('user-2')).toBe(true)
    expect(isTemplateId('My_Template')).toBe(true)
  })

  it('rejects non-strings and non-slugs', () => {
    for (const bad of [undefined, null, 42, '', '.', '..', './x', '../escape', 'a/b', 'a\\b', 'a:b', '.hidden', 'id.json']) {
      expect(isTemplateId(bad)).toBe(false)
    }
  })

  it('refuses to join traversal ids into a template path', async () => {
    const root = path.resolve('resources')
    for (const evil of ['../secret', '..\\secret', 'x/../../secret']) {
      await expect(loadTemplateById(root, evil)).rejects.toThrow(/Invalid template id/)
    }
  })

  it('assertTemplateId throws the readable guard error', () => {
    expect(() => assertTemplateId('../escape')).toThrow(/Invalid template id/)
  })
})
