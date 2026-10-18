import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probeWithCache } from '../../src/core/ffmpeg/probe'
import { resolveFfmpegBinariesCached } from '../../src/core/ffmpeg/resolve-bin'
import { fixture, makeScratchDir, removeScratchDir } from '../helpers/env'

let ffprobePath = ''
let cacheDir = ''

beforeAll(async () => {
  const binaries = await resolveFfmpegBinariesCached({})
  ffprobePath = binaries.ffprobePath
  cacheDir = await makeScratchDir('probe-cache')
})

afterAll(async () => {
  await removeScratchDir(cacheDir)
})

describe('probeWithCache — fixture matrix', () => {
  it('reads a plain landscape clip', async () => {
    const meta = await probeWithCache(fixture('landscape_1080p_10s.mp4'), {
      ffprobePath,
      cacheDir
    })
    expect(meta.codedWidth).toBe(1920)
    expect(meta.codedHeight).toBe(1080)
    expect(meta.width).toBe(1920)
    expect(meta.height).toBe(1080)
    expect(meta.rotation).toBe(0)
    expect(meta.hasAudio).toBe(true)
    expect(meta.audioChannels).toBe(2)
    expect(meta.durationSec).toBeGreaterThan(9)
    expect(meta.durationSec).toBeLessThan(11)
  })

  it('normalizes rotation metadata to display dimensions', async () => {
    const meta = await probeWithCache(fixture('portrait_rotated.mp4'), {
      ffprobePath,
      cacheDir
    })
    expect(meta.rotation).toBe(90)
    expect(meta.codedWidth).toBe(1920)
    expect(meta.codedHeight).toBe(1080)
    expect(meta.width).toBe(1080)
    expect(meta.height).toBe(1920)
  })

  it('detects surround audio and reports its channel count', async () => {
    const meta = await probeWithCache(fixture('surround_5_1.mp4'), { ffprobePath, cacheDir })
    expect(meta.hasAudio).toBe(true)
    expect(meta.audioChannels).toBe(6)
  })

  it('reports no audio for a silent 4:3 source', async () => {
    const meta = await probeWithCache(fixture('square_4x3.avi'), { ffprobePath, cacheDir })
    expect(meta.width).toBe(640)
    expect(meta.height).toBe(480)
    expect(meta.hasAudio).toBe(false)
    expect(meta.audioCodec).toBeNull()
  })

  it('parses a variable-frame-rate source without failing', async () => {
    const meta = await probeWithCache(fixture('landscape_vfr.mp4'), { ffprobePath, cacheDir })
    expect(meta.width).toBe(1280)
    expect(meta.height).toBe(720)
    expect(meta.fps).toBeGreaterThan(0)
    expect(Number.isFinite(meta.fps)).toBe(true)
  })
})

describe('probeWithCache — cache behavior', () => {
  it('writes a versioned envelope and serves repeat probes from it', async () => {
    const dir = await makeScratchDir('probe-cache-hit')
    try {
      const source = fixture('tiny_2s.mp4')
      const first = await probeWithCache(source, { ffprobePath, cacheDir: dir })
      const entries = (await readdir(dir)).filter((f) => f.endsWith('.json'))
      expect(entries).toHaveLength(1)
      const envelope = JSON.parse(await readFile(path.join(dir, entries[0]!), 'utf8')) as {
        v: number
        meta: { width: number }
      }
      expect(envelope.v).toBe(1)
      expect(envelope.meta.width).toBe(first.width)
      const second = await probeWithCache(source, { ffprobePath, cacheDir: dir })
      expect(second).toEqual(first)
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('recovers when the cache file is corrupt', async () => {
    const dir = await makeScratchDir('probe-cache-bad')
    try {
      const source = fixture('tiny_2s.mp4')
      await probeWithCache(source, { ffprobePath, cacheDir: dir })
      const entries = await readdir(dir)
      await writeFile(path.join(dir, entries[0]!), 'not json at all', 'utf8')
      const meta = await probeWithCache(source, { ffprobePath, cacheDir: dir })
      expect(meta.durationSec).toBeGreaterThan(1)
      const healed = JSON.parse(await readFile(path.join(dir, entries[0]!), 'utf8')) as {
        v: number
        meta: { width: number }
      }
      expect(healed.v).toBe(1)
      expect(healed.meta.width).toBe(meta.width)
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('re-probes and rewrites entries from an unknown cache version', async () => {
    const dir = await makeScratchDir('probe-cache-version')
    try {
      const source = fixture('tiny_2s.mp4')
      await probeWithCache(source, { ffprobePath, cacheDir: dir })
      const entries = (await readdir(dir)).filter((f) => f.endsWith('.json'))
      const file = path.join(dir, entries[0]!)
      // Simulate a future schema: same payload, different version marker.
      const future = JSON.parse(await readFile(file, 'utf8')) as { v: number; meta: unknown }
      await writeFile(file, JSON.stringify({ ...future, v: future.v + 1 }), 'utf8')
      const meta = await probeWithCache(source, { ffprobePath, cacheDir: dir })
      expect(meta.durationSec).toBeGreaterThan(1)
      const healed = JSON.parse(await readFile(file, 'utf8')) as { v: number }
      expect(healed.v).toBe(1)
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('re-probes legacy unversioned cache files', async () => {
    const dir = await makeScratchDir('probe-cache-legacy')
    try {
      const source = fixture('tiny_2s.mp4')
      const first = await probeWithCache(source, { ffprobePath, cacheDir: dir })
      const entries = (await readdir(dir)).filter((f) => f.endsWith('.json'))
      const file = path.join(dir, entries[0]!)
      // Legacy shape: the bare ClipMeta at the top level, no envelope.
      const legacy = JSON.parse(await readFile(file, 'utf8')) as { meta: unknown }
      await writeFile(file, JSON.stringify(legacy.meta), 'utf8')
      const meta = await probeWithCache(source, { ffprobePath, cacheDir: dir })
      expect(meta).toEqual(first)
      const healed = JSON.parse(await readFile(file, 'utf8')) as { v: number }
      expect(healed.v).toBe(1)
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('fails with a clear error for a missing file', async () => {
    await expect(probeWithCache(fixture('does-not-exist.mp4'), { ffprobePath })).rejects.toThrow(
      /Failed to start ffprobe|No video stream|ffprobe exited/
    )
  })
})
