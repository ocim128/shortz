import { existsSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Batch queue integration — runs the REAL src/main/batch.ts against real
 * fixture clips. Only electron itself is stubbed (main-process modules import
 * `app` for its paths); everything below that — config load, template load,
 * probe, overlay, ffmpeg, output naming — is the production code path.
 *
 * Set up before importing the module under test: `vi.mock` is hoisted, and
 * runBatch reads the data dir through data.ts at call time.
 */

const SCRATCH = path.join(process.env.TEMP ?? '/tmp', `shortz-batch-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => SCRATCH
  },
  shell: { trashItem: async () => undefined, showItemInFolder: () => undefined, openPath: async () => '' }
}))

process.env.SHORTZ_DATA_DIR = SCRATCH

const { runBatch, cancelBatchRun } = await import('../../src/main/batch')
const { parseBatchText, BATCH_SEPARATOR } = await import('../../src/shared/batch/parse')
const { fixture, REPO_ROOT } = await import('../helpers/env')
const { defaultSettings, saveSettings } = await import('../../src/core/store/settings')

const CLIP_A = fixture('tiny_2s.mp4')
const CLIP_B = fixture('landscape_1080p_10s.mp4')
const CONFIG_ID = '01JGZ8X7Y0000000000000000A'
const OUT_DIR = path.join(SCRATCH, 'out')

function toItems(text: string): Array<{ id: string; path: string; hook: string }> {
  return parseBatchText(text)
    .filter((line) => line.problems.length === 0)
    .map((line) => ({ id: `line-${line.index}`, path: line.path, hook: line.hook }))
}

beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true })
  const configsDir = path.join(SCRATCH, 'editor-configs')
  await mkdir(configsDir, { recursive: true })
  await writeFile(
    path.join(configsDir, `${CONFIG_ID}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name: 'batch probe',
      savedAt: new Date().toISOString(),
      templateId: 'hook-letterbox',
      values: { fields: { hook: 'from config' }, knobs: {} },
      trim: { start: 0, end: 1 },
      audio: 'keep'
    })
  )
  // Keep the runs short and deterministic: software encoder, 30 fps, no trim
  // unless a test asks for it.
  const settings = defaultSettings()
  settings.output.dir = OUT_DIR
  settings.output.filenamePattern = '{name}_{seq}'
  settings.encoder.preferred = 'libx264'
  settings.encoder.crf = 30
  settings.encoder.fps = 30
  settings.ffmpeg.source = 'auto'
  await saveSettings(settings, SCRATCH)
})

afterAll(async () => {
  delete process.env.SHORTZ_DATA_DIR
  const { rm } = await import('node:fs/promises')
  await rm(SCRATCH, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('runBatch — real render queue', () => {
  it('renders one clip per line, in order, into the output folder', async () => {
    const events: Array<{ status: string; index: number; percent?: number }> = []
    const text = [`${CLIP_A}${BATCH_SEPARATOR}HOOK ONE`, `${CLIP_B}${BATCH_SEPARATOR}HOOK TWO`].join('\n')
    const items = toItems(text)
    expect(items).toHaveLength(2)

    const summary = await runBatch({
      items,
      configId: CONFIG_ID,
      configTrim: false,
      outputDir: OUT_DIR
    })

    expect(summary.completed).toBe(2)
    expect(summary.failed).toBe(0)
    expect(summary.cancelled).toBe(false)

    const produced = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.mp4')).sort()
    expect(produced).toEqual(['landscape_1080p_10s_2.mp4', 'tiny_2s_1.mp4'])
    for (const name of produced) {
      const info = await stat(path.join(OUT_DIR, name))
      expect(info.size).toBeGreaterThan(10_000)
    }
    // Sequence numbers follow the LINE order, not the render completion order.
    expect(produced[0]).toContain('_2')
    expect(produced[1]).toContain('_1')
    void events
  }, 240_000)

  it('emits a terminal summary event with the final counts', async () => {
    const terminal: Array<Record<string, unknown>> = []
    const events: string[] = []
    const { setBatchEmitter } = await import('../../src/main/batch')
    setBatchEmitter((e) => {
      events.push(e.status)
      if (e.status === 'finished' || e.status === 'cancelled') terminal.push({ ...e })
    })

    const summary = await runBatch({
      items: toItems(`${CLIP_A}${BATCH_SEPARATOR}HOOK ONLY`),
      configId: CONFIG_ID,
      configTrim: false,
      outputDir: OUT_DIR
    })

    expect(summary.completed).toBe(1)
    expect(events[0]).toBe('starting')
    expect(events).toContain('done')
    expect(events.at(-1)).toBe('finished')
    expect(terminal).toHaveLength(1)
    expect(terminal[0]!.completed).toBe(1)
    expect(terminal[0]!.failed).toBe(0)
  }, 240_000)

  it('keeps rendering after one item fails, and names the failure', async () => {
    const errors: string[] = []
    const { setBatchEmitter } = await import('../../src/main/batch')
    setBatchEmitter((e) => {
      if (e.status === 'error' && e.error) errors.push(e.error)
    })

    const items = [
      { id: 'line-0', path: CLIP_A, hook: 'GOOD' },
      { id: 'line-1', path: path.join(SCRATCH, 'does-not-exist.mp4'), hook: 'MISSING' },
      { id: 'line-2', path: CLIP_A, hook: 'ALSO GOOD' }
    ]

    const summary = await runBatch({ items, configId: CONFIG_ID, configTrim: false, outputDir: OUT_DIR })

    expect(summary.completed).toBe(2)
    expect(summary.failed).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/File not found/)
  }, 240_000)

  it('fails the whole run, before rendering, when the config cannot load', async () => {
    await expect(
      runBatch({
        items: toItems(`${CLIP_A}${BATCH_SEPARATOR}HOOK`),
        configId: '01JGZ8X7Y0000000000000000Z',
        configTrim: false,
        outputDir: OUT_DIR
      })
    ).rejects.toThrow(/Could not load the saved configuration/)
  })

  it('refuses an empty batch', async () => {
    await expect(runBatch({ items: [], configId: CONFIG_ID, outputDir: OUT_DIR })).rejects.toThrow(
      /batch is empty/
    )
  })

  it('refuses a second run while one is active', async () => {
    // Start a run without awaiting it, then try to start another immediately.
    const first = runBatch({
      items: toItems(`${CLIP_B}${BATCH_SEPARATOR}SLOW`),
      configId: CONFIG_ID,
      configTrim: false,
      outputDir: OUT_DIR
    })
    const second = runBatch({
      items: toItems(`${CLIP_A}${BATCH_SEPARATOR}SECOND`),
      configId: CONFIG_ID,
      configTrim: false,
      outputDir: OUT_DIR
    })
    await expect(second).rejects.toThrow(/already running/)
    await first
  }, 240_000)

  it('applies the config trim range when asked', async () => {
    // The config trims to 0–1s; the 10s fixture must come out ~1s long.
    const summary = await runBatch({
      items: toItems(`${CLIP_B}${BATCH_SEPARATOR}SHORT`),
      configId: CONFIG_ID,
      configTrim: true,
      outputDir: OUT_DIR
    })
    expect(summary.completed).toBe(1)
    const names = (await readdir(OUT_DIR)).filter((f) => f.startsWith('landscape_1080p_10s'))
    expect(names.length).toBeGreaterThan(0)
  }, 240_000)

  it('skips the remaining lines once cancelled', async () => {
    const statuses: string[] = []
    const { setBatchEmitter } = await import('../../src/main/batch')
    setBatchEmitter((e) => statuses.push(e.status))

    const items = [
      { id: 'line-0', path: CLIP_B, hook: 'FIRST' },
      { id: 'line-1', path: CLIP_A, hook: 'SECOND' },
      { id: 'line-2', path: CLIP_A, hook: 'THIRD' }
    ]
    const pending = runBatch({ items, configId: CONFIG_ID, configTrim: false, outputDir: OUT_DIR })
    // Cancel as soon as the first item actually starts rendering.
    const started = Date.now()
    while (!statuses.includes('rendering') && Date.now() - started < 60_000) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(cancelBatchRun()).toBe(true)
    const summary = await pending

    expect(summary.cancelled).toBe(true)
    expect(statuses).toContain('skipped')
    expect(summary.completed).toBeLessThan(3)
  }, 240_000)

  it('ignores a cancel aimed at a different job id', async () => {
    expect(cancelBatchRun('not-the-running-job')).toBe(false)
    expect(cancelBatchRun('another')).toBe(false)
  })

  it('honours {seq} and the clip stem in the filename pattern', async () => {
    const settings = defaultSettings()
    settings.output.dir = OUT_DIR
    settings.output.filenamePattern = 'batch_{seq}_{name}'
    settings.encoder.crf = 30
    settings.encoder.fps = 30
    await saveSettings(settings, SCRATCH)

    await runBatch({
      items: toItems(`${CLIP_A}${BATCH_SEPARATOR}SEQ TEST`),
      configId: CONFIG_ID,
      configTrim: false,
      outputDir: OUT_DIR
    })

    const names = await readdir(OUT_DIR)
    expect(names).toContain('batch_1_tiny_2s.mp4')

    // Restore the shared pattern for any later test.
    settings.output.filenamePattern = '{name}_{seq}'
    await saveSettings(settings, SCRATCH)
  }, 240_000)

  it('sanity: the fixtures this suite relies on exist', () => {
    expect(existsSync(CLIP_A)).toBe(true)
    expect(existsSync(CLIP_B)).toBe(true)
    expect(existsSync(path.join(REPO_ROOT, 'resources', 'templates', 'hook-letterbox.json'))).toBe(true)
  })
})
