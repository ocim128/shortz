import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateStore, downloadKey } from '../../../src/core/downloader/store/state'

let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortz-state-'))
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

const TWEET = '1750123456789012352'

async function touch(filePath: string, bytes = 'x'): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, bytes)
  return filePath
}

describe('StateStore — open / persist / recover', () => {
  it('starts empty and creates the downloads folder', async () => {
    const store = await StateStore.open(dataDir)
    expect(store.tweetIds()).toEqual([])
    await store.flush()
    const written = JSON.parse(
      await fs.readFile(path.join(dataDir, 'downloads', 'state.json'), 'utf8')
    ) as { schemaVersion: number }
    expect(written.schemaVersion).toBe(2)
  })

  it('round-trips rows through a flush + reopen', async () => {
    const first = await StateStore.open(dataDir)
    first.noteTweet({
      tweetId: TWEET,
      author: 'someuser',
      caption: 'hello',
      url: `https://x.com/someuser/status/${TWEET}`,
      mediaCount: 1
    })
    const file = await touch(path.join(dataDir, 'out', `${TWEET}.mp4`))
    first.recordDownload({
      tweetId: TWEET,
      mediaIndex: 1,
      filePath: file,
      sizeBytes: 12,
      status: 'ok',
      source: 'syndication',
      runId: 'job-1'
    })
    await first.flush()

    const second = await StateStore.open(dataDir)
    expect(second.tweet(TWEET)?.caption).toBe('hello')
    expect(second.downloadsOf(TWEET)).toHaveLength(1)
    expect(await second.isComplete(TWEET)).toBe(true)
  })

  it('quarantines a corrupt document instead of crashing', async () => {
    const file = path.join(dataDir, 'downloads', 'state.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{"schemaVersion": 2, "tweets": {broken')

    const store = await StateStore.open(dataDir)
    expect(store.tweetIds()).toEqual([])
    const entries = await fs.readdir(path.join(dataDir, 'downloads'))
    expect(entries.some((entry) => entry.startsWith('state.corrupt-'))).toBe(true)
  })

  it('treats an unknown schema version as corrupt (forward-compat safety)', async () => {
    const file = path.join(dataDir, 'downloads', 'state.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 99, tweets: {}, downloads: {} }))
    const store = await StateStore.open(dataDir)
    expect(store.tweetIds()).toEqual([])
    const entries = await fs.readdir(path.join(dataDir, 'downloads'))
    expect(entries.some((entry) => entry.startsWith('state.corrupt-'))).toBe(true)
  })

  it('survives a BOM in the document', async () => {
    const file = path.join(dataDir, 'downloads', 'state.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      `\uFEFF${JSON.stringify({ schemaVersion: 2, tweets: {}, downloads: {}, runs: {} })}`
    )
    const store = await StateStore.open(dataDir)
    expect(store.tweetIds()).toEqual([])
    // Not quarantined: the BOM was tolerated.
    const entries = await fs.readdir(path.join(dataDir, 'downloads'))
    expect(entries.some((entry) => entry.startsWith('state.corrupt-'))).toBe(false)
  })

  it('serializes concurrent flushes into a valid document', async () => {
    const store = await StateStore.open(dataDir)
    store.noteTweet({ tweetId: TWEET, author: 'a', caption: 'c', url: 'u', mediaCount: 1 })
    await Promise.all([store.flush(), store.flush(), store.flush()])
    const raw = await fs.readFile(path.join(dataDir, 'downloads', 'state.json'), 'utf8')
    expect(() => JSON.parse(raw) as unknown).not.toThrow()
  })

  it('flushSoon coalesces a trailing write; flush() supersedes the timer', async () => {
    const store = await StateStore.open(dataDir)
    store.noteTweet({ tweetId: TWEET, author: 'a', caption: 'c', url: 'u', mediaCount: 1 })
    store.flushSoon(5)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const written = JSON.parse(
      await fs.readFile(path.join(dataDir, 'downloads', 'state.json'), 'utf8')
    ) as { tweets: Record<string, unknown> }
    expect(Object.keys(written.tweets)).toEqual([TWEET])

    store.noteTweet({ tweetId: '999', author: 'b', caption: 'd', url: 'u', mediaCount: 1 })
    store.flushSoon(60_000)
    await store.flush()
    const afterBarrier = JSON.parse(
      await fs.readFile(path.join(dataDir, 'downloads', 'state.json'), 'utf8')
    ) as { tweets: Record<string, unknown> }
    expect(Object.keys(afterBarrier.tweets).sort()).toEqual([TWEET, '999'].sort())
  })

  it('writes the document compactly (machine-only state)', async () => {
    const store = await StateStore.open(dataDir)
    store.noteTweet({ tweetId: TWEET, author: 'a', caption: 'c', url: 'u', mediaCount: 1 })
    await store.flush()
    const raw = await fs.readFile(path.join(dataDir, 'downloads', 'state.json'), 'utf8')
    expect(raw.includes('\n')).toBe(false)
  })

  it('a mutation during an in-flight write is not lost by the coalesced flush', async () => {
    const store = await StateStore.open(dataDir)
    store.noteTweet({ tweetId: TWEET, author: 'a', caption: 'c', url: 'u', mediaCount: 2 })
    const first = await touch(path.join(dataDir, 'out', 'one.mp4'))
    store.recordDownload({
      tweetId: TWEET,
      mediaIndex: 1,
      filePath: first,
      sizeBytes: 1,
      status: 'ok',
      source: 'syndication',
      runId: 'j1'
    })
    const flushing = store.flush()
    // Lands while the write above is queued/in flight.
    const second = await touch(path.join(dataDir, 'out', 'two.mp4'))
    store.recordDownload({
      tweetId: TWEET,
      mediaIndex: 2,
      filePath: second,
      sizeBytes: 1,
      status: 'ok',
      source: 'syndication',
      runId: 'j1'
    })
    await Promise.all([flushing, store.flush()])

    const reopened = await StateStore.open(dataDir)
    expect(reopened.downloadsOf(TWEET)).toHaveLength(2)
  })
})

describe('StateStore — the completeness rule (storage-naming.md §4)', () => {
  it('is incomplete while any media row is missing, even if files exist', async () => {
    const store = await StateStore.open(dataDir)
    store.noteTweet({ tweetId: TWEET, author: 'a', caption: 'c', url: 'u', mediaCount: 2 })
    const one = await touch(path.join(dataDir, 'out', 'one.mp4'))
    store.recordDownload({
      tweetId: TWEET,
      mediaIndex: 1,
      filePath: one,
      sizeBytes: 1,
      status: 'ok',
      source: 'syndication',
      runId: 'job'
    })
    expect(await store.isComplete(TWEET)).toBe(false)
  })

  it('is incomplete when a row says ok but the file is gone', async () => {
    const store = await StateStore.open(dataDir)
    store.noteTweet({ tweetId: TWEET, author: 'a', caption: 'c', url: 'u', mediaCount: 1 })
    store.recordDownload({
      tweetId: TWEET,
      mediaIndex: 1,
      filePath: path.join(dataDir, 'out', 'missing.mp4'),
      sizeBytes: 10,
      status: 'ok',
      source: 'syndication',
      runId: 'job'
    })
    expect(await store.isComplete(TWEET)).toBe(false)
  })

  it('a failed row never counts as complete', async () => {
    const store = await StateStore.open(dataDir)
    store.noteTweet({ tweetId: TWEET, author: 'a', caption: 'c', url: 'u', mediaCount: 1 })
    const file = await touch(path.join(dataDir, 'out', 'v.mp4'))
    store.recordDownload({
      tweetId: TWEET,
      mediaIndex: 1,
      filePath: file,
      sizeBytes: 1,
      status: 'failed',
      error: 'NETWORK',
      source: 'syndication',
      runId: 'job'
    })
    expect(await store.isComplete(TWEET)).toBe(false)
  })

  it('a photo-only post (mediaCount 0) never anchors a skip', async () => {
    const store = await StateStore.open(dataDir)
    store.noteTweet({ tweetId: TWEET, author: 'a', caption: 'c', url: 'u', mediaCount: 0 })
    expect(await store.isComplete(TWEET)).toBe(false)
  })

  it('an unknown tweet is not complete', async () => {
    const store = await StateStore.open(dataDir)
    expect(await store.isComplete('123')).toBe(false)
  })
})

describe('StateStore — history and retry', () => {
  it('derives partial from media rows and sorts newest first', async () => {
    const store = await StateStore.open(dataDir)
    for (const [id, mediaCount] of [
      ['111', 1],
      ['222', 2]
    ] as const) {
      store.noteTweet({
        tweetId: id,
        author: 'a',
        caption: `caption ${id}`,
        url: `https://x.com/a/status/${id}`,
        mediaCount
      })
    }
    const first = await touch(path.join(dataDir, 'out', 'a.mp4'))
    const second = await touch(path.join(dataDir, 'out', 'b.mp4'))
    store.recordDownload({
      tweetId: '111',
      mediaIndex: 1,
      filePath: first,
      sizeBytes: 5,
      status: 'ok',
      source: 'syndication',
      runId: 'j1',
      at: '2026-10-20T10:00:00Z'
    })
    store.recordDownload({
      tweetId: '222',
      mediaIndex: 1,
      filePath: second,
      sizeBytes: 5,
      status: 'ok',
      source: 'syndication',
      runId: 'j1',
      at: '2026-10-20T11:00:00Z'
    })
    store.recordDownload({
      tweetId: '222',
      mediaIndex: 2,
      filePath: path.join(dataDir, 'out', 'c.mp4'),
      sizeBytes: 0,
      status: 'failed',
      error: 'NETWORK',
      source: 'syndication',
      runId: 'j1',
      at: '2026-10-20T11:00:00Z'
    })

    const entries = store.listEntries(10)
    expect(entries.map((entry) => entry.tweetId)).toEqual(['222', '111'])
    expect(entries[0]?.status).toBe('partial')
    expect(entries[0]?.files.map((file) => file.mediaIndex)).toEqual([1])
    expect(entries[1]?.status).toBe('ok')
    expect(store.listEntries(1)).toHaveLength(1)
  })

  it('indexes downloads per tweet and keeps it correct across forget + reopen', async () => {
    const store = await StateStore.open(dataDir)
    const first = await touch(path.join(dataDir, 'out', 'one.mp4'))
    const second = await touch(path.join(dataDir, 'out', 'two.mp4'))
    store.noteTweet({ tweetId: '111', author: 'a', caption: 'c', url: 'u', mediaCount: 2 })
    store.noteTweet({ tweetId: '222', author: 'b', caption: 'd', url: 'u', mediaCount: 1 })
    store.recordDownload({
      tweetId: '111',
      mediaIndex: 1,
      filePath: first,
      sizeBytes: 1,
      status: 'ok',
      source: 'syndication',
      runId: 'j1'
    })
    store.recordDownload({
      tweetId: '111',
      mediaIndex: 2,
      filePath: second,
      sizeBytes: 1,
      status: 'failed',
      source: 'syndication',
      runId: 'j1'
    })
    store.recordDownload({
      tweetId: '222',
      mediaIndex: 1,
      filePath: first,
      sizeBytes: 1,
      status: 'ok',
      source: 'syndication',
      runId: 'j1'
    })

    expect(store.downloadsOf('111')).toHaveLength(2)
    expect(store.downloadsOf('222')).toHaveLength(1)
    expect(store.downloadsOf('999')).toEqual([])
    expect(store.listEntries(10)).toHaveLength(2)
    expect(store.retryTargets()).toEqual(['111'])

    store.forgetDownload('111', 2)
    expect(store.downloadsOf('111')).toHaveLength(1)

    await store.flush()
    const reopened = await StateStore.open(dataDir)
    expect(reopened.downloadsOf('111')).toHaveLength(1)
    expect(reopened.downloadsOf('222')).toHaveLength(1)
    expect(reopened.retryTargets()).toEqual(['111'])
  })

  it('retryTargets lists failed and incomplete posts, never complete ones', async () => {
    const store = await StateStore.open(dataDir)
    const ok = await touch(path.join(dataDir, 'out', 'ok.mp4'))
    store.noteTweet({ tweetId: '111', author: 'a', caption: 'c', url: 'u', mediaCount: 1 })
    store.recordDownload({
      tweetId: '111',
      mediaIndex: 1,
      filePath: ok,
      sizeBytes: 1,
      status: 'ok',
      source: 'syndication',
      runId: 'j'
    })
    store.noteTweet({ tweetId: '222', author: 'a', caption: 'c', url: 'u', mediaCount: 2 })
    store.recordDownload({
      tweetId: '222',
      mediaIndex: 1,
      filePath: ok,
      sizeBytes: 1,
      status: 'ok',
      source: 'syndication',
      runId: 'j'
    })
    store.noteTweet({ tweetId: '333', author: 'a', caption: 'c', url: 'u', mediaCount: 1 })
    store.recordDownload({
      tweetId: '333',
      mediaIndex: 1,
      filePath: path.join(dataDir, 'out', 'gone.mp4'),
      sizeBytes: 0,
      status: 'failed',
      error: 'NETWORK',
      source: 'syndication',
      runId: 'j'
    })

    expect(store.retryTargets()).toEqual(['222', '333'])
  })

  it('forgetDownload removes a row without touching the tweet row', async () => {
    const store = await StateStore.open(dataDir)
    store.noteTweet({ tweetId: TWEET, author: 'a', caption: 'c', url: 'u', mediaCount: 1 })
    store.recordDownload({
      tweetId: TWEET,
      mediaIndex: 1,
      filePath: 'f',
      sizeBytes: 1,
      status: 'ok',
      source: 'syndication',
      runId: 'j'
    })
    expect(store.snapshot().downloads[downloadKey(TWEET, 1)]).toBeDefined()
    store.forgetDownload(TWEET, 1)
    expect(store.snapshot().downloads[downloadKey(TWEET, 1)]).toBeUndefined()
    expect(store.tweet(TWEET)).not.toBeNull()
  })

  it('noteTweet keeps the original firstSeen', async () => {
    const store = await StateStore.open(dataDir)
    store.noteTweet({
      tweetId: TWEET,
      author: 'a',
      caption: '1',
      url: 'u',
      mediaCount: 1,
      at: '2026-01-01T00:00:00Z'
    })
    store.noteTweet({
      tweetId: TWEET,
      author: 'a',
      caption: '2',
      url: 'u',
      mediaCount: 2,
      at: '2026-02-01T00:00:00Z'
    })
    expect(store.tweet(TWEET)?.firstSeen).toBe('2026-01-01T00:00:00Z')
    expect(store.tweet(TWEET)?.caption).toBe('2')
    expect(store.tweet(TWEET)?.mediaCount).toBe(2)
  })

  it('records the run under the runId', async () => {
    const store = await StateStore.open(dataDir)
    store.recordRun(
      { jobId: 'job-9', total: 2, ok: 1, skipped: 1, partial: 0, failed: 0, cancelled: false },
      '2026-10-20T10:00:00Z',
      '2026-10-20T10:00:30Z'
    )
    const run = store.snapshot().runs['job-9']
    expect(run?.ok).toBe(1)
    expect(run?.finishedAt).toBe('2026-10-20T10:00:30Z')
  })
})
