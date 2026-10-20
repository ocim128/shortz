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

describe('loadSettings — downloads (twitter-downloader, AUDIT A13)', () => {
  it('adds the downloads block to defaults', async () => {
    const settings = await loadSettings(path.join(scratchDir, 'missing-downloads'))
    expect(settings.downloads.dir.length).toBeGreaterThan(0)
    expect(settings.downloads.layout).toBe('by-author')
    expect(settings.downloads.filenameTemplate).toBe('{id}')
    expect(settings.downloads.quality).toBe('best')
    expect(settings.downloads.resolveConcurrency).toBe(4)
    expect(settings.downloads.downloadConcurrency).toBe(3)
    expect(settings.downloads.fallback).toBe('off')
    expect(settings.downloads.writeSidecars).toBe(true)
  })

  it('loads a pre-downloader settings file with defaults and schemaVersion 1', async () => {
    await writeSettings(
      JSON.stringify({
        schemaVersion: 1,
        output: { dir: 'C:\\Videos', filenamePattern: '{name}' },
        encoder: { preferred: 'libx264', crf: 20, fps: 60 },
        ffmpeg: { source: 'system' },
        ui: { safeZonesDefault: false }
      })
    )
    const settings = await loadSettings(scratchDir)
    expect(settings.schemaVersion).toBe(1)
    expect(settings.output.dir).toBe('C:\\Videos')
    expect(settings.downloads.filenameTemplate).toBe('{id}')
    expect(settings.downloads.downloadConcurrency).toBe(3)
  })

  it('clamps every hand-edited downloads field to a valid value', async () => {
    await writeSettings(
      JSON.stringify({
        downloads: {
          dir: '',
          layout: 'nope',
          filenameTemplate: '',
          quality: 'ultra',
          resolveConcurrency: 0,
          downloadConcurrency: 9,
          fallback: 'ytdlp',
          writeSidecars: 'yes'
        }
      })
    )
    const settings = await loadSettings(scratchDir)
    expect(settings.downloads.dir.length).toBeGreaterThan(0)
    expect(settings.downloads.layout).toBe('by-author')
    expect(settings.downloads.filenameTemplate).toBe('{id}')
    expect(settings.downloads.quality).toBe('best')
    expect(settings.downloads.resolveConcurrency).toBe(4)
    expect(settings.downloads.downloadConcurrency).toBe(3)
    expect(settings.downloads.fallback).toBe('off')
    expect(settings.downloads.writeSidecars).toBe(true)
  })

  it('keeps valid downloads values, including a maxHeight quality', async () => {
    await writeSettings(
      JSON.stringify({
        downloads: {
          dir: 'D:\\clips',
          layout: 'flat',
          filenameTemplate: '{author}_{id}_{slug}',
          quality: { maxHeight: 720 },
          resolveConcurrency: 2,
          downloadConcurrency: 1,
          fallback: 'fxtwitter',
          writeSidecars: false
        }
      })
    )
    const settings = await loadSettings(scratchDir)
    expect(settings.downloads).toEqual({
      dir: 'D:\\clips',
      layout: 'flat',
      filenameTemplate: '{author}_{id}_{slug}',
      quality: { maxHeight: 720 },
      resolveConcurrency: 2,
      downloadConcurrency: 1,
      fallback: 'fxtwitter',
      writeSidecars: false
    })
  })

  it('rejects an implausible maxHeight quality and a scalar downloads block', async () => {
    await writeSettings(JSON.stringify({ downloads: { quality: { maxHeight: 'huge' } } }))
    expect((await loadSettings(scratchDir)).downloads.quality).toBe('best')

    await writeSettings(JSON.stringify({ downloads: 'on' }))
    const settings = await loadSettings(scratchDir)
    expect(settings.downloads.downloadConcurrency).toBe(3)
    expect(settings.downloads.quality).toBe('best')
  })
})
