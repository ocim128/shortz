/**
 * The poster cache — `<dataDir>/downloads/cache/posters/<tweetId>_<n>.jpg`
 * (storage-naming.md §5).
 *
 * Posters are UI state, not content: the renderer performs zero remote I/O, so
 * the core the fetches them and main serves them via `media://`. Discipline
 * (AUDIT A19):
 *  - **skip when the file exists** (a poster never changes for a given media);
 *  - failures are best-effort and never fail the item;
 *  - Analyze (dry-run) fetches them **lazily** — a preview of 25 links must not
 *    pull 25 images nobody looked at;
 *  - the 30-day sweep (`sweepPosterCache`) is wired into main's startup path
 *    (`src/main/sweep.ts`), which also covers a long-lived CLI data dir.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DlClient } from '../net/client'

/** 30 days, per storage-naming.md §5. */
export const POSTER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function posterCacheDir(dataDir: string): string {
  return path.join(dataDir, 'downloads', 'cache', 'posters')
}

export function posterPath(dataDir: string, tweetId: string, mediaIndex: number): string {
  return path.join(posterCacheDir(dataDir), `${tweetId}_${mediaIndex}.jpg`)
}

export interface PosterResult {
  path: string
  /** True when this call actually hit the network. */
  fetched: boolean
}

/**
 * Ensure a poster is cached. Never throws: a failed poster returns
 * `{ path: null }` at the orchestrator's boundary, and the item is unaffected.
 */
export async function ensurePoster(args: {
  dataDir: string
  tweetId: string
  mediaIndex: number
  posterUrl: string | null
  client: DlClient
  signal: AbortSignal
}): Promise<PosterResult | null> {
  if (args.posterUrl === null || args.posterUrl.length === 0) return null
  const target = posterPath(args.dataDir, args.tweetId, args.mediaIndex)
  try {
    const stat = await fs.stat(target)
    if (stat.isFile() && stat.size > 0) return { path: target, fetched: false }
  } catch {
    // not cached yet — fall through
  }
  // Write to a temp name so a half-downloaded JPEG never looks cached.
  const temp = `${target}.${process.pid}.part`
  try {
    await fs.mkdir(posterCacheDir(args.dataDir), { recursive: true })
    await fs.rm(temp, { force: true }).catch(() => undefined)
    await args.client.streamTo(args.posterUrl, temp, { signal: args.signal })
    await fs.rename(temp, target)
    return { path: target, fetched: true }
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    return null
  }
}

/**
 * Sweep poster files older than `maxAgeMs` (default 30 days). Best-effort:
 * the cache is UI state, so a failed sweep must never block startup.
 */
export async function sweepPosterCache(
  dataDir: string,
  maxAgeMs: number = POSTER_MAX_AGE_MS
): Promise<string[]> {
  const dir = posterCacheDir(dataDir)
  const removed: string[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return removed
  }
  const now = Date.now()
  for (const entry of entries) {
    const full = path.join(dir, entry)
    try {
      const stat = await fs.stat(full)
      if (!stat.isFile()) continue
      if (now - stat.mtimeMs < maxAgeMs) continue
      await fs.unlink(full)
      removed.push(full)
    } catch {
      // best effort
    }
  }
  return removed
}
