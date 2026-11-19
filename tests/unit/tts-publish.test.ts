import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { publishNarrationArtifacts } from '../../src/core/tts/publish'
import type { NarrationArtifacts } from '../../src/core/tts/pipeline'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

describe('publish narration artifacts', () => {
  it.each([false, true])('publishes exclusively and preserves resume data on conflict=%s', async (conflict) => {
    const dir = await makeScratchDir('tts-publish')
    try {
      const staged = ['stage.mp3', 'stage-times.json', 'stage-report.json'].map((name) => path.join(dir, name))
      await Promise.all(staged.map((file) => writeFile(file, 'data')))
      const target = path.join(dir, 'out.mp3')
      if (conflict) await writeFile(path.join(dir, 'out-report.json'), 'existing')
      const cleanup = vi.fn(async () => undefined)
      const artifacts: NarrationArtifacts = { mp3: staged[0]!, timestamps: staged[1]!, report: staged[2]!,
        passed: true, durationSec: 1, audioQuality: { integratedLufs: null, loudnessRangeLu: null, noiseFloorDbfs: null }, cleanup }
      if (conflict) {
        await expect(publishNarrationArtifacts(artifacts, target)).rejects.toThrow('Output already exists')
        await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(path.join(dir, 'out-report.json'), 'utf8')).toBe('existing')
      } else {
        const result = await publishNarrationArtifacts(artifacts, target)
        expect(await readFile(target, 'utf8')).toBe('data')
        expect(await readFile(result.report, 'utf8')).toBe('data')
      }
      expect(cleanup).toHaveBeenCalledWith({ preserveCache: conflict })
    } finally { await removeScratchDir(dir) }
  })
})
