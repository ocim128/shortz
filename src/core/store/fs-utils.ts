import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** Retry delays for Windows transient file locks (EBUSY/EPERM), ~1s total. */
export const DEFAULT_RETRY_DELAYS_MS = [150, 300, 600]

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Editors on Windows happily prepend a UTF-8 BOM; JSON.parse does not. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
}

/**
 * Run an fs operation with backoff retries on Windows-style transient lock errors.
 * Non-transient errors (ENOENT, EXDEV, ...) are thrown immediately.
 */
export async function retryFs<T>(
  operation: () => Promise<T>,
  delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isTransientFsError(error)) throw error
      lastError = error
      const delay = delays[attempt]
      if (delay !== undefined) await sleep(delay)
    }
  }
  throw lastError
}

/** Remove a file or directory tree, retrying while Windows holds handles. */
export async function rmWithRetry(
  target: string,
  delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS
): Promise<boolean> {
  try {
    await retryFs(() => fs.rm(target, { recursive: true, force: true }), delays)
    return true
  } catch {
    return false
  }
}

/**
 * Move a file with EPERM retry; falls back to copy+delete across drives (EXDEV).
 */
export async function moveWithRetry(
  source: string,
  destination: string,
  delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS
): Promise<void> {
  try {
    await retryFs(() => fs.rename(source, destination), delays)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  await retryFs(async () => {
    await fs.copyFile(source, destination)
    await fs.unlink(source)
  }, delays)
}

/**
 * Atomic write: temp file next to the target + rename with retry.
 * The temp file lives in the same directory so the rename stays on one volume.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS
): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  )
  try {
    await fs.writeFile(tmp, data)
    await retryFs(() => fs.rename(tmp, filePath), delays)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** First free path: notes.txt -> notes_1.txt -> notes_2.txt ... */
export function uniqueOutputPath(target: string): string {
  if (!existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}_${i}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`Could not find a free output filename for ${target}`)
}

/** Startup sweep: delete child directories of `root` older than maxAgeMs. */
export async function sweepStaleDirs(root: string, maxAgeMs: number): Promise<string[]> {
  const removed: string[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return removed
  }
  const now = Date.now()
  for (const entry of entries) {
    const full = path.join(root, entry)
    try {
      const stat = await fs.stat(full)
      if (!stat.isDirectory()) continue
      if (now - stat.mtimeMs < maxAgeMs) continue
      if (await rmWithRetry(full)) removed.push(full)
    } catch {
      // best effort
    }
  }
  return removed
}
