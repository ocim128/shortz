/**
 * `fetchToFile` — one chosen variant, one file (download-engine.md §1).
 *
 * The engine never imports resolver types: it takes `(url, dest, ctx)` and the
 * orchestrator hands it a URL (xdl layering rule 6). Everything that can go wrong
 * becomes a `DlError` with a code; the *sentences* live in `copy.ts`.
 *
 * The .part protocol:
 *   <dest>.part        partial bytes, kept on abort/network failure
 *   <dest>.part.json   {etag, lastModified, total} — the If-Range validator
 *
 * A 200 answer to a ranged request restarts from zero, a 416 at exactly 100 %
 * finalizes without a byte, and an exact-size mismatch after a clean stream is
 * INTEGRITY_MISMATCH (the .part is deleted so the retry is a clean restart).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DlError } from '../../../shared/downloader/errors'
import { isAllowedMediaUrl } from '../../../shared/downloader/urls'
import { moveWithRetry } from '../../store/fs-utils'
import type { DlClient } from '../net/client'
import type { ThrottleState } from './throttle'

export interface FetchCtx {
  client: DlClient
  throttle: ThrottleState
  /** Composed: run signal + per-item signal. */
  signal: AbortSignal
  onProgress: (delta: number, total: number | null) => void
  /** A size the state index already knows (its `sizeBytes`); lets an already
   * complete .part skip the request entirely. */
  expectedTotal?: number | null
}

export interface DownloadOutcome {
  bytes: number
  total: number | null
  /** Request attempts used (1 when nothing was retried; retries are the
   * orchestrator's job, so this counts attempts inside one call). */
  attempts: number
  elapsedMs: number
}

interface Validator {
  etag: string | null
  lastModified: string | null
  total: number | null
}

export function partPathOf(dest: string): string {
  return `${dest}.part`
}

export function validatorPathOf(dest: string): string {
  return `${dest}.part.json`
}

async function readValidator(path: string): Promise<Validator | null> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const total =
      typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : null
    return {
      etag: typeof record.etag === 'string' ? record.etag : null,
      lastModified: typeof record.lastModified === 'string' ? record.lastModified : null,
      total
    }
  } catch {
    return null
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const stat = await fs.stat(path)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

/** The If-Range value: prefer the strong ETag, else the Last-Modified date. */
function ifRangeOf(validator: Validator | null): string | null {
  if (validator === null) return null
  if (validator.etag !== null && !validator.etag.startsWith('W/')) return validator.etag
  return validator.lastModified
}

function mapWriteError(error: unknown): never {
  if (error instanceof DlError) throw error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOSPC') throw new DlError('DISK_FULL', 'write failed: ENOSPC')
  if (code === 'ENOENT') throw new DlError('WRITE_ERROR', 'destination folder disappeared')
  throw new DlError('WRITE_ERROR', code ?? (error instanceof Error ? error.message : String(error)))
}

/**
 * Download one variant to `dest` (final path). The caller owns retries; this
 * function either finalizes the file or throws with the .part left in place.
 */
export async function fetchToFile(
  url: string,
  dest: string,
  ctx: FetchCtx
): Promise<DownloadOutcome> {
  const startedAt = Date.now()

  // 1. Trust boundary first: a hostile URL never reaches the client's socket.
  if (!isAllowedMediaUrl(url)) {
    throw new DlError('URL_UNRECOGNIZED', `media host not allowed: ${url.slice(0, 80)}`)
  }

  const part = partPathOf(dest)
  const validatorPath = validatorPathOf(dest)
  const validator = await readValidator(validatorPath)
  const existing = await sizeOf(part)
  const expected = validator?.total ?? ctx.expectedTotal ?? null
  const offset = existing ?? 0

  try {
    await fs.mkdir(path.dirname(dest), { recursive: true })
  } catch (error) {
    mapWriteError(error)
  }

  // 2. Already complete: the interrupted-at-100 % case (audit rev 2). No request.
  if (existing !== null && expected !== null && existing === expected) {
    await fs.unlink(validatorPath).catch(() => undefined)
    await moveWithRetry(part, dest).catch(mapWriteError)
    return {
      bytes: existing,
      total: expected,
      attempts: 0,
      elapsedMs: Date.now() - startedAt
    }
  }

  // 3. Pace the request through the shared brain.
  await ctx.throttle.gate()

  const response = await ctx.client.streamTo(url, part, {
    signal: ctx.signal,
    offset,
    ifRange: offset > 0 ? ifRangeOf(validator) : null,
    onProgress: ctx.onProgress,
    validatorPath
  })

  const size = await sizeOf(part)
  if (size === null) {
    throw new DlError('WRITE_ERROR', 'the .part file vanished while downloading')
  }

  // 4. Integrity: an exact size is the only checksum this feature needs (§5).
  const total = response.total ?? expected
  if (total !== null && size !== total) {
    await fs.unlink(part).catch(() => undefined)
    await fs.unlink(validatorPath).catch(() => undefined)
    throw new DlError('INTEGRITY_MISMATCH', `expected ${total} bytes, got ${size}`)
  }

  // 5. Finalize: media rename → (sidecar/state are the orchestrator's), and the
  // rename is only as durable as the fsync the client already did.
  try {
    await moveWithRetry(part, dest)
  } catch (error) {
    mapWriteError(error)
  }
  await fs.unlink(validatorPath).catch(() => undefined)

  return {
    bytes: size,
    total,
    attempts: 1,
    elapsedMs: Date.now() - startedAt
  }
}

/** Delete the partial + validator for a clean restart (INTEGRITY_MISMATCH retry). */
export async function discardPartial(dest: string): Promise<void> {
  await fs.unlink(partPathOf(dest)).catch(() => undefined)
  await fs.unlink(validatorPathOf(dest)).catch(() => undefined)
}
