import { app } from 'electron'
import path from 'node:path'
import { logInfo } from '../core/log'
import { sweepStaleDirs } from '../core/store/fs-utils'
import { sweepPosterCache } from '../core/downloader/store/posters'
import { dataDir } from './data'

/**
 * Startup sweeps (docs/02-architecture.md §failure handling): crash-leftover
 * render temp dirs (24 h) and the downloader poster cache (30 days, A19).
 * Fire-and-forget — never blocks window creation, errors swallowed.
 */
export async function sweepStaleRenderTemp(): Promise<void> {
  const dir = path.join(app.getPath('temp'), 'shortz')
  const removed = await sweepStaleDirs(dir, 24 * 3600_000)
  if (removed.length > 0) {
    logInfo(`[shortz] temp sweep removed ${removed.length} stale dir(s) under ${dir}`)
  }

  // Posters are ~50–150 KB each and never change for a given media; without
  // this the cache grew for the lifetime of the install.
  const posters = await sweepPosterCache(dataDir())
  if (posters.length > 0) {
    logInfo(`[dl] poster sweep removed ${posters.length} file(s) older than 30 days`)
  }
}
