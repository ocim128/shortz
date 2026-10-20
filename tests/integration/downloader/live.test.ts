/**
 * Live smoke tests — opt-in only (`LIVE_DL=1`).
 *
 * These hit the real endpoints, so they are skipped by default and are NOT part
 * of the hermetic gate. What they prove, and nothing more:
 *  - the syndication endpoint still answers in the shape the adapter maps;
 *  - selection produces a variant on a real allow-listed media host;
 *  - a dry run through `runDl` writes nothing;
 *  - the failure-path probe still separates an alive post (200) from a gone one
 *    (404) — the one live assumption behind `NOT_FOUND` vs `NOT_EMBEDDABLE`.
 *
 * Defaults are a public NASA post with one video. A deleted default should not
 * block a live run: override it with `LIVE_DL_URL` (and optionally
 * `LIVE_DL_GONE_ID` for the probe's negative case).
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createDlClient } from '../../../src/core/downloader/net/client'
import { runDl } from '../../../src/core/downloader/orchestrator'
import { buildChain, createOembedProbe } from '../../../src/core/downloader/resolve/chain'
import { selectAllChosen } from '../../../src/shared/downloader/select'
import type { DlEvent, DlItemEvent } from '../../../src/shared/downloader/types'
import { parseStatusUrl } from '../../../src/shared/downloader/urls'

const LIVE = process.env.LIVE_DL === '1'
const LIVE_URL = process.env.LIVE_DL_URL ?? 'https://x.com/NASA/status/2105842656429432894'
const GONE_ID = process.env.LIVE_DL_GONE_ID ?? '1750123456789012352'
const TIMEOUT_MS = 120_000

const scratch: string[] = []

async function scratchDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shortz-live-'))
  scratch.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of scratch) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe.skipIf(!LIVE)('live smoke (LIVE_DL=1)', () => {
  it(
    'resolves a real post, chooses an allow-listed video and plans without writing',
    async () => {
      const root = await scratchDir()
      const dataDir = path.join(root, 'data')
      const outDir = path.join(root, 'out')
      const ref = parseStatusUrl(LIVE_URL)
      const events: DlEvent[] = []

      const summary = await runDl(
        {
          inputs: [{ key: 'line-1', lineNumber: 1, text: LIVE_URL }],
          dryRun: true,
          outputDir: outDir
        },
        {
          jobId: 'live-dry-run',
          dataDir,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          onEvent: (event) => events.push(event),
          options: {
            outputDir: outDir,
            layout: 'by-author',
            filenameTemplate: '{id}',
            quality: 'best',
            resolveConcurrency: 1,
            downloadConcurrency: 1,
            fallback: 'auto',
            writeSidecars: true,
            force: false,
            dryRun: true,
            retryFailed: false
          }
        }
      )

      expect(summary.total).toBe(1)
      expect(summary.ok).toBe(1)
      expect(summary.failed).toBe(0)

      const planned = events.find(
        (event): event is DlItemEvent => event.kind === 'item' && event.item.status === 'planned'
      )
      expect(planned).toBeDefined()
      expect(planned?.item.tweetId).toBe(ref.tweetId)
      expect(planned?.item.author?.length ?? 0).toBeGreaterThan(0)

      const chosen = planned?.item.chosen ?? []
      expect(chosen.length).toBeGreaterThan(0)
      for (const variant of chosen) {
        const url = new URL(variant.url)
        expect(url.protocol).toBe('https:')
        expect(url.hostname === 'twimg.com' || url.hostname.endsWith('.twimg.com')).toBe(true)
        expect(variant.height ?? 0).toBeGreaterThan(0)
      }
      expect(planned?.item.plannedPaths?.[0]?.endsWith('.mp4')).toBe(true)

      // Analyze writes nothing — no state, no media.
      await expect(fs.stat(path.join(dataDir, 'downloads', 'state.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    },
    TIMEOUT_MS
  )

  it(
    'the live variant URL answers with video bytes and a range',
    async () => {
      const ref = parseStatusUrl(LIVE_URL)
      const client = createDlClient({ fallback: 'auto' })
      const chain = buildChain({ fallback: 'auto', client, probe: null })
      const resolved = await chain.resolve(ref, {
        client,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      }) // What the app would actually download: selection drops HLS ladders
      // (`application/x-mpegURL`) whenever a progressive MP4 exists.
      const chosen = selectAllChosen(resolved, 'best')
      expect(chosen.length).toBeGreaterThan(0)
      const url = chosen[0]?.variant.url
      expect(url).toBeDefined()

      const res = await fetch(url as string, {
        headers: { range: 'bytes=0-1023', 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      expect([200, 206]).toContain(res.status)
      expect(res.headers.get('content-type') ?? '').toContain('video/')
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
    },
    TIMEOUT_MS
  )

  it(
    'the failure probe still separates alive (200) from gone (404)',
    async () => {
      const client = createDlClient({ fallback: 'auto' })
      const probe = createOembedProbe(client)
      const signal = AbortSignal.timeout(TIMEOUT_MS)

      const alive = await probe(parseStatusUrl(LIVE_URL), { client, signal })
      expect(alive).toBe('alive')

      const gone = await probe(
        {
          tweetId: GONE_ID,
          screenName: null,
          canonicalUrl: `https://x.com/i/status/${GONE_ID}`
        },
        { client, signal }
      )
      expect(gone).toBe('gone')
    },
    TIMEOUT_MS
  )
})
