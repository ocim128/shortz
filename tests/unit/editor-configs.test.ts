import { readdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EDITOR_CONFIG_NAME_MAX,
  deleteEditorConfig,
  editorConfigsDir,
  listEditorConfigs,
  loadEditorConfig,
  sanitizeEditorConfig,
  saveEditorConfig
} from '../../src/core/store/editor-configs'
import type { EditorConfig } from '../../src/shared/domain'
import { makeScratchDir, readJson, removeScratchDir } from '../helpers/env'

type SaveInput = Parameters<typeof saveEditorConfig>[0]

function sampleConfig(overrides: Partial<SaveInput> = {}): SaveInput {
  return {
    schemaVersion: 1,
    name: 'squirrel reel',
    templateId: 'hook-letterbox',
    values: {
      fields: { hook: 'A baby squirrel learns to use a spoon.' },
      knobs: { backgroundStyle: 'black', videoTop: 520 }
    },
    trim: { start: 1.5, end: 18.2 },
    audio: 'keep',
    ...overrides
  }
}

describe('editor configs — named slots', () => {
  it('lists nothing when the folder does not exist yet', async () => {
    const dir = await makeScratchDir('cfg-empty')
    try {
      expect(await listEditorConfigs(dir)).toEqual([])
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('round-trips save → list → load and stamps savedAt', async () => {
    const dir = await makeScratchDir('cfg-rt')
    try {
      const meta = await saveEditorConfig(sampleConfig(), dir)
      expect(meta.name).toBe('squirrel reel')
      expect(meta.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

      const listed = await listEditorConfigs(dir)
      expect(listed).toEqual([meta])

      const loaded = await loadEditorConfig(meta.id, dir)
      expect(loaded.name).toBe('squirrel reel')
      expect(loaded.templateId).toBe('hook-letterbox')
      expect(loaded.values.knobs).toEqual({ backgroundStyle: 'black', videoTop: 520 })

      const onDisk = readJson(
        path.join(editorConfigsDir(dir), `${meta.id}.json`)
      ) as EditorConfig
      expect(onDisk.name).toBe('squirrel reel')
      expect(onDisk.savedAt).toBe(meta.savedAt)
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('saving with an existing name updates that config instead of adding one', async () => {
    const dir = await makeScratchDir('cfg-dedupe')
    try {
      const first = await saveEditorConfig(sampleConfig(), dir)
      // Different case + surrounding whitespace still resolve to the same slot.
      const second = await saveEditorConfig(
        sampleConfig({ name: '  Squirrel Reel', audio: 'mute' }),
        dir
      )
      expect(second.id).toBe(first.id)
      expect((await listEditorConfigs(dir)).length).toBe(1)

      const loaded = await loadEditorConfig(first.id, dir)
      expect(loaded.audio).toBe('mute')
      expect(loaded.name).toBe('Squirrel Reel')
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('keeps distinct names as distinct configs, listed newest first', async () => {
    const dir = await makeScratchDir('cfg-multi')
    try {
      const a = await saveEditorConfig(sampleConfig({ name: 'reel a' }), dir)
      expect((await listEditorConfigs(dir)).map((m) => m.name)).toEqual(['reel a'])
      const b = await saveEditorConfig(sampleConfig({ name: 'reel b' }), dir)
      const names = (await listEditorConfigs(dir)).map((m) => m.name)
      expect(names).toEqual(['reel b', 'reel a'])
      expect(readdirSync(editorConfigsDir(dir)).length).toBe(2)
      expect(a.id).not.toBe(b.id)
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('delete removes exactly the targeted config', async () => {
    const dir = await makeScratchDir('cfg-delete')
    try {
      const a = await saveEditorConfig(sampleConfig({ name: 'keep me' }), dir)
      const b = await saveEditorConfig(sampleConfig({ name: 'delete me' }), dir)
      await deleteEditorConfig(b.id, dir)
      const names = (await listEditorConfigs(dir)).map((m) => m.name)
      expect(names).toEqual(['keep me'])
      await expect(loadEditorConfig(b.id, dir)).rejects.toThrow(/No saved configuration/)
      await expect(loadEditorConfig(a.id, dir)).resolves.toMatchObject({ name: 'keep me' })
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('a corrupt file is skipped by the list but fails its own load with a readable error', async () => {
    const dir = await makeScratchDir('cfg-corrupt')
    try {
      const good = await saveEditorConfig(sampleConfig({ name: 'healthy' }), dir)
      const bad = await saveEditorConfig(sampleConfig({ name: 'broken' }), dir)
      await writeFile(path.join(editorConfigsDir(dir), `${bad.id}.json`), '{not json', 'utf8')

      expect((await listEditorConfigs(dir)).map((m) => m.name)).toEqual(['healthy'])
      await expect(loadEditorConfig(good.id, dir)).resolves.toMatchObject({ name: 'healthy' })
      await expect(loadEditorConfig(bad.id, dir)).rejects.toThrow(/not valid JSON/)
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('rejects non-ULID ids before touching the filesystem', async () => {
    const dir = await makeScratchDir('cfg-badid')
    try {
      await expect(loadEditorConfig('../../evil', dir)).rejects.toThrow(/Invalid project id/)
      await expect(deleteEditorConfig('../../../evil', dir)).rejects.toThrow(/Invalid project id/)
    } finally {
      await removeScratchDir(dir)
    }
  })
})

describe('sanitizeEditorConfig', () => {
  const valid: EditorConfig = {
    schemaVersion: 1,
    name: 'squirrel reel',
    savedAt: '2026-10-18T09:00:00.000Z',
    templateId: 'hook-letterbox',
    values: {
      fields: { hook: 'A baby squirrel learns to use a spoon.' },
      knobs: { backgroundStyle: 'black' }
    },
    trim: { start: 1.5, end: 18.2 },
    audio: 'keep'
  }

  it('trims the name and rejects the shape violations a corrupt file could carry', () => {
    expect(sanitizeEditorConfig({ ...valid, name: '  padded  ' }).name).toBe('padded')

    const bad: unknown[] = [
      null,
      'nope',
      { ...valid, name: '   ' },
      { ...valid, name: 42 },
      { ...valid, name: 'x'.repeat(EDITOR_CONFIG_NAME_MAX + 1) },
      { ...valid, savedAt: 'yesterday' },
      { ...valid, templateId: '' },
      { ...valid, values: null },
      { ...valid, values: { fields: 'x', knobs: {} } },
      { ...valid, values: { ...valid.values, fields: { hook: 7 } } },
      { ...valid, values: { fields: {}, knobs: [] } },
      { ...valid, trim: { start: -1, end: 2 } },
      { ...valid, trim: { start: 3, end: 3 } },
      { ...valid, trim: { start: '0', end: 2 } },
      { ...valid, audio: 'loud' }
    ]
    for (const doc of bad) {
      expect(() => sanitizeEditorConfig(doc)).toThrow(/editor config:/)
    }
  })

  it('accepts {0,0} — the documented "no trim" value a disabled editor saves', () => {
    const out = sanitizeEditorConfig({ ...valid, trim: { start: 0, end: 0 } })
    expect(out.trim).toEqual({ start: 0, end: 0 })
  })
})
