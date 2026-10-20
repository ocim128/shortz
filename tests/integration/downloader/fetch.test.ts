import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDlClient } from '../../../src/core/downloader/net/client'
import { fetchToFile, partPathOf, validatorPathOf } from '../../../src/core/downloader/engine/fetch'
import { ThrottleState } from '../../../src/core/downloader/engine/throttle'
import { DlError } from '../../../src/shared/downloader/errors'
import {
  fakeFetch,
  fakeVideoBytes,
  rangeMediaRoute,
  truncatedMediaRoute,
  type FakeRoute
} from '../../unit/downloader/helpers/fixtures'

const MEDIA_URL = 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/v.mp4?tag=12'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shortz-fetch-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function ctx(routes: FakeRoute[], options: { signal?: AbortSignal; expectedTotal?: number } = {}) {
  const fetchImpl = fakeFetch(routes)
  const client = createDlClient({ fetchImpl, fallback: 'off' })
  return {
    fetchImpl,
    ctx: {
      client,
      throttle: new ThrottleState(() => performance.now(), options.signal, { minGapMs: 0 }),
      signal: options.signal ?? new AbortController().signal,
      onProgress: () => undefined,
      ...(options.expectedTotal === undefined ? {} : { expectedTotal: options.expectedTotal })
    }
  }
}

function destOf(name = 'video.mp4'): string {
  return path.join(root, 'x', 'author', name)
}

async function sizeOf(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath)
  return stat.size
}

describe('fetchToFile — the .part protocol', () => {
  it('downloads, fsyncs and renames the file into place', async () => {
    const body = fakeVideoBytes(4096)
    const dest = destOf()
    const { ctx: fetchCtx, fetchImpl } = ctx([rangeMediaRoute(body)])
    const outcome = await fetchToFile(MEDIA_URL, dest, fetchCtx)

    expect(outcome.bytes).toBe(4096)
    expect(outcome.total).toBe(4096)
    expect(await sizeOf(dest)).toBe(4096)
    expect(fetchImpl.count('video.twimg.com')).toBe(1)
    // No stray partial artefacts after a clean run.
    await expect(fs.stat(partPathOf(dest))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(validatorPathOf(dest))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('sends Range + If-Range and appends when a .part already exists', async () => {
    const body = fakeVideoBytes(4096)
    const dest = destOf()
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(partPathOf(dest), body.slice(0, 1024))
    await fs.writeFile(
      validatorPathOf(dest),
      JSON.stringify({ etag: '"media-v1"', lastModified: null, total: 4096 })
    )

    const { ctx: fetchCtx, fetchImpl } = ctx([rangeMediaRoute(body)])
    const outcome = await fetchToFile(MEDIA_URL, dest, fetchCtx)

    expect(outcome.bytes).toBe(4096)
    const call = fetchImpl.calls[0]
    expect(call?.headers.range).toBe('bytes=1024-')
    expect(call?.headers['if-range']).toBe('"media-v1"')
    expect(await sizeOf(dest)).toBe(4096)
    // The resumed bytes are the real ones, not 1024..2048 twice.
    expect((await fs.readFile(dest)).equals(Buffer.from(body))).toBe(true)
  })

  it('a 200 answer to a ranged request truncates and restarts (no doubled file)', async () => {
    const body = fakeVideoBytes(2048)
    const dest = destOf()
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(partPathOf(dest), body.slice(0, 512))

    const { ctx: fetchCtx } = ctx([rangeMediaRoute(body, { ignoreRange: true })])
    await fetchToFile(MEDIA_URL, dest, fetchCtx)
    expect(await sizeOf(dest)).toBe(2048)
    expect((await fs.readFile(dest)).equals(Buffer.from(body))).toBe(true)
  })

  it('416 at exactly 100 % finalizes without any body', async () => {
    const body = fakeVideoBytes(1024)
    const dest = destOf()
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(partPathOf(dest), body)
    await fs.writeFile(
      validatorPathOf(dest),
      JSON.stringify({ etag: '"media-v1"', lastModified: null, total: 1024 })
    )

    const { ctx: fetchCtx } = ctx([rangeMediaRoute(body)])
    // expectedTotal known + size === total ⇒ zero requests at all.
    const outcome = await fetchToFile(MEDIA_URL, dest, fetchCtx)
    expect(outcome.bytes).toBe(1024)
    expect(outcome.attempts).toBe(0)
    expect(await sizeOf(dest)).toBe(1024)
  })

  it('416 with a stale .part is deleted and restarted from zero', async () => {
    const body = fakeVideoBytes(1024)
    const dest = destOf()
    await fs.mkdir(path.dirname(dest), { recursive: true })
    // A .part longer than the object (no validator claiming otherwise): the
    // server answers 416 forever unless the engine drops it.
    await fs.writeFile(partPathOf(dest), fakeVideoBytes(4096))

    const { ctx: fetchCtx, fetchImpl } = ctx([rangeMediaRoute(body)])
    await fetchToFile(MEDIA_URL, dest, fetchCtx)
    expect(await sizeOf(dest)).toBe(1024)
    expect(fetchImpl.calls.length).toBeGreaterThanOrEqual(2)
    expect(fetchImpl.calls[1]?.headers.range).toBeUndefined()
  })

  it('deletes the .part and reports INTEGRITY_MISMATCH on an exact-size failure', async () => {
    const dest = destOf()
    // Content-Length lies: 4096 declared, 1000 delivered.
    const lying: FakeRoute = {
      match: 'video.twimg.com',
      respond: () =>
        new Response(fakeVideoBytes(1000) as unknown as BodyInit, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '4096' }
        })
    }
    const { ctx: fetchCtx } = ctx([lying])
    await expect(fetchToFile(MEDIA_URL, dest, fetchCtx)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH'
    })
    await expect(fs.stat(partPathOf(dest))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the .part when the transfer dies mid-body (resume later)', async () => {
    const body = fakeVideoBytes(8192)
    const dest = destOf()
    const { ctx: fetchCtx } = ctx([truncatedMediaRoute(body, 2048)])
    await expect(fetchToFile(MEDIA_URL, dest, fetchCtx)).rejects.toMatchObject({ code: 'NETWORK' })
    await expect(fs.stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
    const part = await fs.readFile(partPathOf(dest))
    expect(part.byteLength).toBeGreaterThan(0)
    expect(part.byteLength).toBeLessThanOrEqual(2048)
  })

  it('keeps the .part on cancel, and the next run resumes from it', async () => {
    const body = fakeVideoBytes(8192)
    const dest = destOf()
    const controller = new AbortController()

    const first = ctx([truncatedMediaRoute(body, 4096)], { signal: controller.signal })
    await expect(fetchToFile(MEDIA_URL, dest, first.ctx)).rejects.toMatchObject({ code: 'NETWORK' })
    const partial = await sizeOf(partPathOf(dest))

    const second = ctx([rangeMediaRoute(body)])
    const outcome = await fetchToFile(MEDIA_URL, dest, second.ctx)
    expect(outcome.bytes).toBe(8192)
    expect(second.fetchImpl.calls[0]?.headers.range).toBe(`bytes=${partial}-`)
    expect((await fs.readFile(dest)).equals(Buffer.from(body))).toBe(true)
  })

  it('refuses a hostile URL before opening a socket', async () => {
    const { ctx: fetchCtx, fetchImpl } = ctx([rangeMediaRoute(fakeVideoBytes(10))])
    await expect(
      fetchToFile('https://evil.example/v.mp4', destOf(), fetchCtx)
    ).rejects.toMatchObject({ code: 'URL_UNRECOGNIZED' })
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('maps 403 to LINK_EXPIRED and 429 to RATE_LIMITED', async () => {
    for (const [status, code] of [
      [403, 'LINK_EXPIRED'],
      [429, 'RATE_LIMITED'],
      [404, 'NOT_FOUND'],
      [500, 'UPSTREAM_ERROR']
    ] as const) {
      const { ctx: fetchCtx } = ctx([
        { match: 'video.twimg.com', respond: () => new Response(null, { status }) }
      ])
      await expect(fetchToFile(MEDIA_URL, destOf(), fetchCtx)).rejects.toMatchObject({ code })
    }
  })

  it('an abort surfaces as an AbortError, never as NETWORK', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx: fetchCtx } = ctx([rangeMediaRoute(fakeVideoBytes(16))], {
      signal: controller.signal
    })
    await expect(fetchToFile(MEDIA_URL, destOf(), fetchCtx)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('writes a validator beside the .part so an interrupt leaves If-Range data', async () => {
    const body = fakeVideoBytes(4096)
    const dest = destOf()
    const { ctx: fetchCtx } = ctx([truncatedMediaRoute(body, 1024)])
    await expect(fetchToFile(MEDIA_URL, dest, fetchCtx)).rejects.toMatchObject({ code: 'NETWORK' })
    const validator = JSON.parse(await fs.readFile(validatorPathOf(dest), 'utf8')) as {
      total: number | null
    }
    expect(validator.total).toBe(4096)
  })
})

describe('fetchToFile — error taxonomy', () => {
  it('a disk-full write becomes DISK_FULL', async () => {
    // A directory where the .part file should go: the open() fails with EISDIR.
    const dest = destOf()
    await fs.mkdir(partPathOf(dest), { recursive: true })
    const { ctx: fetchCtx } = ctx([rangeMediaRoute(fakeVideoBytes(64))])
    await expect(fetchToFile(MEDIA_URL, dest, fetchCtx)).rejects.toBeInstanceOf(DlError)
  })
})
