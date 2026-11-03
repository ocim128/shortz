import { mkdir, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BatchSourceResolver } from '../../src/main/batch-resolve'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

/**
 * Batch source resolution — the shortcut that lets a batch line say
 * `2112680262353969521.mp4` (or just the id) instead of the full path.
 */

const ID = '2112680262353969521'
let scratch = ''
let downloads = ''
let output = ''

async function touch(file: string, mtime: Date): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'x')
  await utimes(file, mtime, mtime)
  return file
}

beforeAll(async () => {
  scratch = await makeScratchDir('batch-resolve')
  downloads = path.join(scratch, 'Downloads')
  output = path.join(scratch, 'Out')
  await touch(path.join(downloads, 'x', 'Rainmaker1973', `${ID}.mp4`), new Date('2026-01-01T00:00:00Z'))
  await touch(path.join(output, 'rendered.mp4'), new Date('2026-01-01T00:00:00Z'))
  await touch(path.join(downloads, 'x', 'Rainmaker1973', 'notes.txt'), new Date('2026-01-01T00:00:00Z'))
})

afterAll(async () => {
  await removeScratchDir(scratch)
})

function resolver(): BatchSourceResolver {
  return new BatchSourceResolver({ roots: [downloads, output], cwd: scratch })
}

describe('BatchSourceResolver', () => {
  it('resolves a bare file name to the downloaded file', async () => {
    const file = await resolver().resolve(`${ID}.mp4`)
    expect(file).toBe(path.join(downloads, 'x', 'Rainmaker1973', `${ID}.mp4`))
  })

  it('resolves a bare id with no extension', async () => {
    const file = await resolver().resolve(ID)
    expect(file).toBe(path.join(downloads, 'x', 'Rainmaker1973', `${ID}.mp4`))
  })

  it('keeps an exact absolute path untouched', async () => {
    const exact = path.join(output, 'rendered.mp4')
    expect(await resolver().resolve(exact)).toBe(exact)
  })

  it('resolves a path fragment relative to a search root', async () => {
    const file = await resolver().resolve(path.join('x', 'Rainmaker1973', `${ID}.mp4`))
    expect(file).toBe(path.join(downloads, 'x', 'Rainmaker1973', `${ID}.mp4`))
  })

  it('searches the output folder too', async () => {
    expect(await resolver().resolve('rendered.mp4')).toBe(path.join(output, 'rendered.mp4'))
  })

  it('does not match a non-video file', async () => {
    await expect(resolver().resolve('notes.txt')).rejects.toThrow(/File not found/)
  })

  it('names the folders it searched when nothing matches', async () => {
    await expect(resolver().resolve('nothing-here.mp4')).rejects.toThrow(
      new RegExp(`File not found: nothing-here\\.mp4 \\(also searched by name in .*Downloads`)
    )
  })

  it('picks the newest file when two folders hold the same name', async () => {
    // Same name in two author folders — the downloader just wrote the newer one.
    const older = path.join(downloads, 'x', 'A', 'same.mp4')
    const newer = path.join(downloads, 'x', 'B', 'same.mp4')
    await touch(older, new Date('2026-01-01T00:00:00Z'))
    await touch(newer, new Date('2026-05-01T00:00:00Z'))
    expect(await resolver().resolve('same.mp4')).toBe(newer)
  })

  it('rejects an empty location', async () => {
    await expect(resolver().resolve('   ')).rejects.toThrow(/no file location/)
  })
})
