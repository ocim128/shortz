import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadSettings, settingsFilePath } from '../../src/core/store/settings'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

let scratchDir = ''

beforeAll(async () => {
  scratchDir = await makeScratchDir('settings')
})

afterAll(async () => {
  if (scratchDir) await removeScratchDir(scratchDir)
})

async function writeSettings(raw: string): Promise<void> {
  await writeFile(settingsFilePath(scratchDir), raw, 'utf8')
}

describe('loadSettings — normalization', () => {
  it('returns defaults when no file exists', async () => {
    const settings = await loadSettings(path.join(scratchDir, 'missing'))
    expect(settings.encoder.preferred).toBe('auto')
    expect(settings.ffmpeg.source).toBe('auto')
  })

  it('keeps valid values and unknown keys', async () => {
    await writeSettings(
      JSON.stringify({
        encoder: { preferred: 'h264_nvenc', crf: 20, fps: 'source' },
        ffmpeg: { source: 'system' },
        futureKey: { nested: true }
      })
    )
    const settings = await loadSettings(scratchDir)
    expect(settings.encoder.preferred).toBe('h264_nvenc')
    expect(settings.encoder.crf).toBe(20)
    expect(settings.encoder.fps).toBe('source')
    expect(settings.ffmpeg.source).toBe('system')
  })

  it('normalizes out-of-domain enum values to defaults', async () => {
    await writeSettings(
      JSON.stringify({
        encoder: { preferred: 'gpu-magic', crf: 51, fps: 120 },
        ffmpeg: { source: 'weird' },
        output: { dir: '', filenamePattern: 42 },
        ui: { safeZonesDefault: 'yes' }
      })
    )
    const settings = await loadSettings(scratchDir)
    expect(settings.encoder.preferred).toBe('auto')
    expect(settings.encoder.crf).toBe(18)
    expect(settings.encoder.fps).toBe(30)
    expect(settings.ffmpeg.source).toBe('auto')
    expect(settings.output.dir.length).toBeGreaterThan(0)
    expect(typeof settings.output.filenamePattern).toBe('string')
    expect(settings.output.filenamePattern.length).toBeGreaterThan(0)
    expect(settings.ui.safeZonesDefault).toBe(true)
  })

  it('falls back to defaults for unparseable settings', async () => {
    await writeSettings('{not json')
    const settings = await loadSettings(scratchDir)
    expect(settings.encoder.preferred).toBe('auto')
  })
})
