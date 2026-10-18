import path from 'node:path'
import { app } from 'electron'
import { logInfo } from '../core/log'
import { sweepStaleDirs } from '../core/store/fs-utils'

/**
 * Startup sweep of stale render temp dirs (docs/02-architecture.md §failure
 * handling: crash leftovers). Deletes %TEMP%\shortz\* older than 24 h.
 * Fire-and-forget — never blocks window creation, errors swallowed.
 */
export async function sweepStaleRenderTemp(): Promise<void> {
  const dir = path.join(app.getPath('temp'), 'shortz')
  const removed = await sweepStaleDirs(dir, 24 * 3600_000)
  if (removed.length > 0) {
    logInfo(`[shortz] temp sweep removed ${removed.length} stale dir(s) under ${dir}`)
  }
}
