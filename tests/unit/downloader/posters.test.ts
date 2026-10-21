import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  POSTER_MAX_AGE_MS,
  posterCacheDir,
  posterPath,
  sweepPosterCache
} from '../../../src/core/downloader/store/posters'

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortz-posters-'))
  await fs.mkdir(posterCacheDir(dataDir), { recursive: true })
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

/** Write a poster and backdate its mtime by `ageMs`. */
async function poster(tweetId: string, ageMs: number): Promise<string> {
  const file = posterPath(dataDir, tweetId, 1)
  await fs.writeFile(file, 'jpeg')
  const at = new Date(Date.now() - ageMs)
  await fs.utimes(file, at, at)
  return file
}

describe('sweepPosterCache (wired into main startup)', () => {
  it('removes posters older than the 30-day policy and keeps fresh ones', async () => {
    const stale = await poster('111', POSTER_MAX_AGE_MS + 60_000)
    const fresh = await poster('222', 60_000)

    const removed = await sweepPosterCache(dataDir)

    expect(removed).toEqual([stale])
    await expect(fs.stat(stale)).rejects.toThrow()
    await expect(fs.stat(fresh)).resolves.toBeTruthy()
  })

  it('is a no-op when the cache directory does not exist', async () => {
    await fs.rm(posterCacheDir(dataDir), { recursive: true, force: true })
    await expect(sweepPosterCache(dataDir)).resolves.toEqual([])
  })
})
