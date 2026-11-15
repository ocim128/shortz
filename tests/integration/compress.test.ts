import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compressVideo } from '../../src/core/ffmpeg/compress'
import { probeSource } from '../../src/core/ffmpeg/probe'
import { resolveFfmpegBinariesCached } from '../../src/core/ffmpeg/resolve-bin'
import { fixture, makeScratchDir, removeScratchDir } from '../helpers/env'

let dir = ''
let ffmpegPath = ''
let ffprobePath = ''

beforeAll(async () => {
  dir = await makeScratchDir('compress')
  ;({ ffmpegPath, ffprobePath } = await resolveFfmpegBinariesCached())
})
afterAll(async () => {
  await removeScratchDir(dir)
})

describe('video compression', () => {
  it('preserves the source and existing outputs, and produces a playable video with audio', async () => {
    const source = path.join(dir, 'clip.mp4')
    await copyFile(fixture('tiny_2s.mp4'), source)
    const original = await readFile(source)
    const existing = path.join(dir, 'clip_compressed.mp4')
    await writeFile(existing, 'existing output')
    const result = await compressVideo({ source, quality: 'balanced', ffmpegPath, ffprobePath })
    expect(result.path).toBe(path.join(dir, 'clip_compressed_1.mp4'))
    expect(await readFile(existing, 'utf8')).toBe('existing output')
    expect(await readFile(source)).toEqual(original)
    const [before, after] = await Promise.all([
      probeSource(ffprobePath, source),
      probeSource(ffprobePath, result.path)
    ])
    expect(after.videoCodec).toBe('h264')
    expect(after.hasAudio).toBe(before.hasAudio)
    expect(after.width).toBe(before.width)
    expect(after.height).toBe(before.height)
    expect(after.durationSec).toBeCloseTo(before.durationSec, 0)
  })

  it('removes the incomplete output if ffmpeg fails to start', async () => {
    const source = path.join(dir, 'failure.mp4')
    await copyFile(fixture('tiny_2s.mp4'), source)
    await expect(
      compressVideo({
        source,
        quality: 'small',
        ffmpegPath: path.join(dir, 'missing-ffmpeg'),
        ffprobePath
      })
    ).rejects.toThrow()
    expect(await readdir(dir)).not.toContain('failure_compressed.mp4')
  })
})
