import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDl, type DlRunOptions } from '../../../src/core/downloader/orchestrator'
import { ThrottleState } from '../../../src/core/downloader/engine/throttle'
import { StateStore } from '../../../src/core/downloader/store/state'
import { sidecarPathFor } from '../../../src/core/downloader/store/sidecar'
import { DlError } from '../../../src/shared/downloader/errors'
import type { DlEvent, DlItemEvent } from '../../../src/shared/downloader/types'
import {
  fakeFetch,
  fakeVideoBytes,
  jsonResponse,
  posterRoute,
  rangeMediaRoute,
  readFixtureBody,
  type FakeRoute
} from '../../unit/downloader/helpers/fixtures'

const SINGLE = '1750123456789012352'
const MULTI = '1750123456789012353'
const BODY = fakeVideoBytes(3000, 11)

let dataDir: string
let outDir: string

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shortz-run-'))
  dataDir = path.join(root, 'data')
  outDir = path.join(root, 'out')
  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(outDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(path.dirname(dataDir), { recursive: true, force: true })
})

function options(overrides: Partial<DlRunOptions> = {}): DlRunOptions {
  return {
    outputDir: outDir,
    layout: 'by-author',
    filenameTemplate: '{id}',
    quality: 'best',
    resolveConcurrency: 4,
    downloadConcurrency: 3,
    fallback: 'off',
    writeSidecars: true,
    force: false,
    dryRun: false,
    retryFailed: false,
    ...overrides
  }
}

function syndicationFor(payload: unknown): FakeRoute {
  return { match: 'cdn.syndication.twimg.com/tweet-result', respond: () => jsonResponse(payload) }
}

interface Harness {
  events: DlEvent[]
  fetchImpl: ReturnType<typeof fakeFetch>
  run: (
    inputs: string[],
    overrides?: Partial<DlRunOptions>,
    extra?: {
      signal?: AbortSignal
      onEvent?: (event: DlEvent) => void
      retryFailed?: boolean
      state?: StateStore
      logger?: (message: string) => void
    }
  ) => Promise<Awaited<ReturnType<typeof runDl>>>
}

function harness(routes: FakeRoute[]): Harness {
  const fetchImpl = fakeFetch(routes)
  const events: DlEvent[] = []
  return {
    events,
    fetchImpl,
    run: async (inputs, overrides = {}, extra = {}) => {
      const state = extra.state ?? (await StateStore.open(dataDir))
      return runDl(
        {
          inputs: inputs.map((text, index) => ({
            key: `line-${index + 1}`,
            lineNumber: index + 1,
            text
          })),
          ...(extra.retryFailed === true ? { retryFailed: true as const } : {})
        },
        {
          jobId: 'job-test',
          dataDir,
          state,
          signal: extra.signal ?? new AbortController().signal,
          options: options(overrides),
          fetchImpl: fetchImpl as unknown as typeof fetch,
          backoffMs: [0, 0, 0],
          // Tests must not pay the real 200–500 ms pacing gap.
          throttle: new ThrottleState(() => performance.now(), extra.signal, { minGapMs: 0 }),
          logger: extra.logger ?? (() => undefined),
          onEvent: (event) => {
            events.push(event)
            extra.onEvent?.(event)
          }
        }
      )
    }
  }
}

function itemEvents(events: DlEvent[]): DlItemEvent[] {
  return events.filter((event): event is DlItemEvent => event.kind === 'item')
}

function terminal(events: DlEvent[]): DlItemEvent[] {
  return itemEvents(events).filter((event) =>
    ['ok', 'partial', 'failed', 'skipped', 'planned', 'cancelled'].includes(event.item.status)
  )
}

function runDone(events: DlEvent[]): DlEvent[] {
  return events.filter((event) => event.kind === 'run-done')
}

const singleUrl = `https://x.com/someuser/status/${SINGLE}`

describe('runDl — analyze (dry run)', () => {
  it('plans without writing media or state, and prints what it chose', async () => {
    const h = harness([
      syndicationFor(readFixtureBody('syndication/single-video.json')),
      posterRoute()
    ])
    const summary = await h.run([singleUrl], { dryRun: true })

    const planned = terminal(h.events)
    expect(planned).toHaveLength(1)
    const item = planned[0]?.item
    expect(item?.status).toBe('planned')
    expect(item?.author).toBe('someuser')
    expect(item?.caption).toBe('A single video post')
    expect(item?.plannedPaths?.[0]).toBe(path.join(outDir, 'x', 'someuser', `${SINGLE}.mp4`))
    // The chosen variant is reported so the CLI renderer can show 1280x720.
    expect(item?.chosen?.[0]).toMatchObject({ width: 1280, height: 720, bitrate: 2176000 })

    expect(summary.ok).toBe(1)
    expect(summary.failed).toBe(0)
    // No media request, no state file, no output file.
    expect(h.fetchImpl.count('video.twimg.com')).toBe(0)
    await expect(fs.stat(path.join(dataDir, 'downloads', 'state.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      fs.stat(path.join(outDir, 'x', 'someuser', `${SINGLE}.mp4`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runDone(h.events)).toHaveLength(1)
  })
})

describe('runDl — download', () => {
  it('writes the media, the sidecar and the state row, then skips on a second run', async () => {
    const h = harness([
      syndicationFor(readFixtureBody('syndication/single-video.json')),
      rangeMediaRoute(BODY),
      posterRoute()
    ])
    const summary = await h.run([singleUrl])

    expect(summary.ok).toBe(1)
    const dest = path.join(outDir, 'x', 'someuser', `${SINGLE}.mp4`)
    expect(await fs.readFile(dest)).toEqual(Buffer.from(BODY))

    const sidecar = JSON.parse(await fs.readFile(sidecarPathFor(dest), 'utf8')) as {
      tweetId: string
      source: string
      media: { sizeBytes: number; bitrate: number; file: string }[]
    }
    expect(sidecar.tweetId).toBe(SINGLE)
    expect(sidecar.source).toBe('syndication')
    expect(sidecar.media[0]?.sizeBytes).toBe(BODY.byteLength)
    expect(sidecar.media[0]?.bitrate).toBe(2176000)
    expect(sidecar.media[0]?.file).toBe(`${SINGLE}.mp4`)

    // A state row never points at a file that does not exist.
    const state = await StateStore.open(dataDir)
    const rows = state.downloadsOf(SINGLE)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('ok')
    expect(await fs.stat(rows[0]?.filePath ?? '')).toBeTruthy()

    // Second identical run: zero requests, one skip.
    const before = h.fetchImpl.calls.length
    const second = await h.run([singleUrl])
    expect(second.skipped).toBe(1)
    expect(second.ok).toBe(0)
    expect(h.fetchImpl.calls.length).toBe(before)
    const skip = terminal(h.events).at(-1)
    expect(skip?.item.skipReason).toBe('already-downloaded')
  })

  it('re-finalizes a file that exists with its sidecar but no state row', async () => {
    const h = harness([
      syndicationFor(readFixtureBody('syndication/single-video.json')),
      rangeMediaRoute(BODY),
      posterRoute()
    ])
    await h.run([singleUrl])

    // Simulate the crash window: media + sidecar on disk, index lost.
    const statePath = path.join(dataDir, 'downloads', 'state.json')
    await fs.unlink(statePath)

    const before = h.fetchImpl.calls.length
    const second = await h.run([singleUrl])
    expect(second.ok).toBe(1)
    // One resolve + one poster, but no second media request.
    expect(h.fetchImpl.count('video.twimg.com')).toBe(
      // the first run fetched the media twice? no: exactly once, so it stays 1
      1
    )
    expect(h.fetchImpl.calls.length).toBeGreaterThan(before - 1)
  })

  it('reports a partial when one of three videos fails, keeping the ones that worked', async () => {
    const h = harness([
      syndicationFor(readFixtureBody('syndication/multi-video.json')),
      // Only the first asset's URL is served; the rest 500 forever.
      {
        match: 'multi-1-832.mp4',
        respond: () =>
          new Response(BODY as unknown as BodyInit, {
            status: 200,
            headers: { 'content-type': 'video/mp4', 'content-length': String(BODY.byteLength) }
          })
      },
      {
        match: (url: string) => url.startsWith('https://video.twimg.com/'),
        respond: () => new Response(null, { status: 500 })
      },
      posterRoute()
    ])
    const summary = await h.run([`https://x.com/multiuser/status/${MULTI}`])

    expect(summary.partial).toBe(1)
    expect(summary.ok).toBe(0)
    const verdict = terminal(h.events).at(-1)
    expect(verdict?.item.status).toBe('partial')
    expect(verdict?.item.files).toHaveLength(1)
    expect(verdict?.item.errorCode).toBe('UPSTREAM_ERROR')
  })
})

describe('runDl — one verdict per line (D-A5)', () => {
  it('gives duplicates, junk and good lines exactly one terminal event each', async () => {
    const h = harness([
      syndicationFor(readFixtureBody('syndication/single-video.json')),
      rangeMediaRoute(BODY),
      posterRoute()
    ])
    const summary = await h.run([
      singleUrl,
      singleUrl,
      'not a link at all',
      'https://x.com/someuser/status/12abc'
    ])

    const finals = terminal(h.events)
    expect(finals).toHaveLength(4)
    expect(new Set(finals.map((event) => event.key)).size).toBe(4)
    // Completion order is not line order; the verdicts are what must line up.
    const byLine = [...finals].sort((a, b) => a.lineNumber - b.lineNumber)
    expect(byLine.map((event) => event.item.status)).toEqual(['ok', 'skipped', 'failed', 'failed'])
    expect(summary.total).toBe(4)
    expect(summary.ok).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(summary.failed).toBe(2)
    expect(runDone(h.events)).toHaveLength(1)
  })

  it('expands a t.co short link once and dedupes against the direct line', async () => {
    const h = harness([
      {
        match: 'https://t.co/',
        respond: () => new Response(null, { status: 301, headers: { location: singleUrl } })
      },
      syndicationFor(readFixtureBody('syndication/single-video.json')),
      rangeMediaRoute(BODY),
      posterRoute()
    ])
    const summary = await h.run(['https://t.co/abc123', singleUrl])
    expect(summary.total).toBe(2)
    expect(summary.ok).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(h.fetchImpl.count('https://t.co/')).toBe(1)
    // Exactly one download happened, whichever line won.
    expect(h.fetchImpl.count('video.twimg.com')).toBe(1)
  })
})

describe('runDl — cancel and the circuit breaker', () => {
  it('emits exactly one run-done on cancel and keeps the .part', async () => {
    const controller = new AbortController()
    const dest = path.join(outDir, 'x', 'someuser', `${SINGLE}.mp4`)
    // A body that delivers one chunk and then goes silent.
    const stalling: FakeRoute = {
      match: 'video.twimg.com',
      respond: () => {
        let sent = false
        const stream = new ReadableStream<Uint8Array>({
          pull(streamController) {
            if (sent) return new Promise<void>(() => undefined)
            sent = true
            streamController.enqueue(BODY.slice(0, 512))
          }
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': String(BODY.byteLength) }
        })
      }
    }
    const h = harness([
      syndicationFor(readFixtureBody('syndication/single-video.json')),
      stalling,
      posterRoute()
    ])

    const summary = await h.run(
      [singleUrl],
      {},
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === 'media-progress' && !controller.signal.aborted) controller.abort()
        }
      }
    )

    expect(summary.cancelled).toBe(true)
    expect(runDone(h.events)).toHaveLength(1)
    expect(runDone(h.events)[0]).toMatchObject({ kind: 'run-done', cancelled: true })
    // The partial bytes survive: the next run resumes from them.
    const part = await fs.readFile(`${dest}.part`)
    expect(part.byteLength).toBeGreaterThan(0)
    await expect(fs.stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('logs every failure with the URL sanitized and the stable code', async () => {
    const logs: string[] = []
    const h = harness([])
    const summary = await h.run(
      ['https://x.com/someuser/status/1?secret=yes'],
      {},
      { logger: (message) => logs.push(message) }
    )

    expect(summary.failed).toBe(1)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('TWEET_ID_INVALID')
    expect(logs[0]).toContain('https://x.com/someuser/status/1')
    expect(logs[0]).not.toContain('secret')
  })

  it('opens after 8 consecutive failures and skips the rest', async () => {
    const routes: FakeRoute[] = [
      { match: 'cdn.syndication.twimg.com', respond: () => new Response(null, { status: 404 }) }
    ]
    const h = harness(routes)
    const ids = Array.from({ length: 11 }, (_value, index) => `17501234567${8000 + index}`)
    const summary = await h.run(
      ids.map((id) => `https://x.com/someuser/status/${id}`),
      { downloadConcurrency: 1, resolveConcurrency: 1 }
    )

    expect(summary.failed).toBeGreaterThanOrEqual(8)
    expect(summary.failed + summary.skipped).toBe(11)
    expect(summary.skipped).toBeGreaterThanOrEqual(1)
    const skips = terminal(h.events).filter((event) => event.item.status === 'skipped')
    expect(skips.every((event) => event.item.skipReason === 'circuit-open')).toBe(true)
    // The breaker stops the TAIL: every skipped line comes after every failure.
    const lastFailure = Math.max(
      ...terminal(h.events)
        .filter((event) => event.item.status === 'failed')
        .map((event) => event.lineNumber)
    )
    for (const skip of skips) expect(skip.lineNumber).toBeGreaterThan(lastFailure)
    expect(runDone(h.events)).toHaveLength(1)
  })
})

describe('runDl — retry-failed', () => {
  it('takes its items from the state index and needs no inputs', async () => {
    const state = await StateStore.open(dataDir)
    state.noteTweet({
      tweetId: SINGLE,
      author: 'someuser',
      caption: 'A single video post',
      url: singleUrl,
      mediaCount: 1
    })
    state.recordDownload({
      tweetId: SINGLE,
      mediaIndex: 1,
      filePath: path.join(outDir, 'never.mp4'),
      sizeBytes: 0,
      status: 'failed',
      error: 'NETWORK',
      source: 'syndication',
      runId: 'old'
    })
    await state.flush()

    const h = harness([
      syndicationFor(readFixtureBody('syndication/single-video.json')),
      rangeMediaRoute(BODY),
      posterRoute()
    ])
    const summary = await h.run([], {}, { retryFailed: true, state })
    expect(summary.total).toBe(1)
    expect(summary.ok).toBe(1)
    const item = terminal(h.events)[0]
    expect(item?.key).toBe(`retry-${SINGLE}`)
  })

  it('rejects a run with no inputs when it is not retry-failed', async () => {
    const h = harness([])
    await expect(h.run([])).rejects.toThrow(/no input lines/)
    expect(h.events).toHaveLength(0)
  })
})

describe('runDl — resolve retry', () => {
  const resolvedOnce = {
    ref: {
      tweetId: SINGLE,
      screenName: 'someuser',
      canonicalUrl: `https://x.com/someuser/status/${SINGLE}`
    },
    author: { screenName: 'someuser', displayName: null, verified: false },
    text: 'A single video post',
    createdAt: null,
    source: 'syndication' as const,
    media: [
      {
        index: 1,
        kind: 'video' as const,
        width: 1280,
        height: 720,
        posterUrl: null,
        variants: [
          {
            url: 'https://video.twimg.com/one.mp4',
            width: 1280,
            height: 720,
            bitrate: 1,
            contentType: 'video/mp4'
          }
        ]
      }
    ]
  }

  async function runWithChain(
    chain: Parameters<typeof runDl>[1]['chain']
  ): Promise<{ summary: Awaited<ReturnType<typeof runDl>>; events: DlEvent[]; resolves: number }> {
    const events: DlEvent[] = []
    let resolves = 0
    const counting = {
      resolve: async (...args: Parameters<NonNullable<typeof chain>['resolve']>) => {
        resolves += 1
        return chain!.resolve(...args)
      }
    }
    const summary = await runDl(
      { inputs: [{ key: 'line-1', lineNumber: 1, text: singleUrl }] },
      {
        jobId: 'job-resolve-retry',
        dataDir,
        signal: new AbortController().signal,
        options: options(),
        chain: counting,
        downloader: async () => ({ bytes: 1, total: 1, attempts: 1, elapsedMs: 1 }),
        throttle: new ThrottleState(() => performance.now(), undefined, { minGapMs: 0 }),
        backoffMs: [0, 0, 0],
        logger: () => undefined,
        onEvent: (event) => events.push(event)
      }
    )
    return { summary, events, resolves }
  }

  it('retries a transient resolve failure and downloads on the second attempt', async () => {
    let attempts = 0
    const { summary, events, resolves } = await runWithChain({
      resolve: async () => {
        attempts += 1
        if (attempts === 1) throw new DlError('UPSTREAM_ERROR', 'syndication: 503')
        return resolvedOnce
      }
    })
    expect(resolves).toBe(2)
    expect(summary.ok).toBe(1)
    expect(terminal(events).map((event) => event.item.status)).toEqual(['ok'])
  })

  it('does not retry a terminal resolve failure (NOT_FOUND)', async () => {
    const { summary, events, resolves } = await runWithChain({
      resolve: async () => {
        throw new DlError('NOT_FOUND', 'gone')
      }
    })
    expect(resolves).toBe(1)
    expect(summary.failed).toBe(1)
    expect(terminal(events)[0]?.item.errorCode).toBe('NOT_FOUND')
  })
})
