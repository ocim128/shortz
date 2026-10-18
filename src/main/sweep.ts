import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

/**
 * Startup sweep of stale render temp dirs (docs/02-architecture.md §failure
 * handling: crash leftovers). Deletes %TEMP%\shortz\* older than 24 h.
 * Fire-and-forget — never blocks window creation, errors swallowed.
 */
export async function sweepStaleRenderTemp(): Promise<void> {
  const dir = path.join(app.getPath('temp'), 'shortz')
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return
  const cutoff = Date.now() - 24 * 3600_000
  let removed = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const stat = await fsp.stat(full).catch(() => null)
    if (!stat) continue
    if (stat.mtimeMs >= cutoff) continue
    await fsp
      .rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      .then(() => {
        removed += 1
      })
      .catch(() => {
        /* best-effort; next launch retries */
      })
  }
  if (removed > 0) console.log(`[shortz] temp sweep removed ${removed} stale dir(s) under ${dir}`)
}
