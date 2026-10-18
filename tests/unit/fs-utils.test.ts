import { existsSync } from 'node:fs'
import { mkdir, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sweepStaleDirs } from '../../src/core/store/fs-utils'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

const DAY_MS = 24 * 3600_000

describe('sweepStaleDirs', () => {
  it('removes only stale child directories, keeping fresh dirs and files', async () => {
    const root = await makeScratchDir('sweep')
    try {
      const stale = path.join(root, 'stale-job')
      const fresh = path.join(root, 'fresh-job')
      await mkdir(stale)
      await mkdir(fresh)
      await writeFile(path.join(root, 'loose.txt'), 'x')
      const old = new Date(Date.now() - 3 * DAY_MS)
      await utimes(stale, old, old)

      const removed = await sweepStaleDirs(root, DAY_MS)
      expect(removed).toEqual([stale])
      expect(existsSync(stale)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
      expect(existsSync(path.join(root, 'loose.txt'))).toBe(true)
    } finally {
      await removeScratchDir(root)
    }
  })

  it('treats a missing root as an empty sweep', async () => {
    const removed = await sweepStaleDirs(path.join(__dirname, 'definitely-not-here'), DAY_MS)
    expect(removed).toEqual([])
  })
})
