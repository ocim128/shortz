import fsp from 'node:fs/promises'
import path from 'node:path'
import { VIDEO_EXTENSIONS } from '../shared/video-extensions'
import { basenameOf, extensionOf, normalizeBatchPath } from '../shared/batch/parse'
import { logInfo } from '../core/log'

/**
 * Batch source resolution — turns whatever the user typed into a real file.
 *
 * Typing full paths for a batch of 40 clips is busywork: the files all come
 * from the same download folder, and the downloader already names them after
 * the post id (`{id}.mp4`). So a batch line may carry any of:
 *
 *   C:\Users\user\Videos\ShortZ\Downloads\x\Rainmaker1973\2112680262353969521.mp4
 *   Downloads\x\Rainmaker1973\2112680262353969521.mp4   (relative to a root)
 *   2112680262353969521.mp4                             (file name)
 *   2112680262353969521                                 (id — extension optional)
 *
 * Resolution order is strict-then-forgiving: an exact path that exists always
 * wins, so a full path is never second-guessed. Only when nothing exists at the
 * typed location does the name index get built, and it is built ONCE per run —
 * a 40-line batch pays for a single folder walk, not 40.
 */

/** Cap the walk so a huge download folder cannot stall a render. */
const MAX_SCAN_ENTRIES = 25_000
/** Deep enough for `by-author/<author>/<file>` plus a few nesting levels. */
const MAX_SCAN_DEPTH = 8

export interface BatchSourceResolverOptions {
  /** Folders searched by file name, in order (downloads folder, output folder). */
  roots: readonly string[]
  /** Base for relative paths. Defaults to the process cwd. */
  cwd?: string
}

interface Candidate {
  file: string
  mtimeMs: number
}

export class BatchSourceResolver {
  private readonly roots: string[]
  private readonly cwd: string
  /** lowercased file name -> absolute paths. */
  private byName: Map<string, string[]> | null = null
  /** lowercased stem -> absolute paths (extension-less input). */
  private byStem: Map<string, string[]> | null = null
  private scan: Promise<void> | null = null

  constructor(options: BatchSourceResolverOptions) {
    this.cwd = options.cwd ?? process.cwd()
    // Dedupe: the default settings put the downloads folder INSIDE the output
    // folder, and walking the same tree twice would double the cost.
    this.roots = [...new Set(options.roots.filter((r) => r.length > 0).map((r) => path.resolve(r)))]
  }

  /**
   * Absolute path of the file this line points at. Throws a "File not found"
   * error naming every folder that was searched when nothing matches.
   */
  async resolve(raw: string): Promise<string> {
    const value = normalizeBatchPath(raw)
    if (value.length === 0) throw new Error('File not found: the line has no file location')

    // 1. Exactly what was typed (absolute, or relative to the cwd).
    const direct = await firstFile([
      path.isAbsolute(value) ? path.normalize(value) : path.resolve(this.cwd, value)
    ])
    if (direct) return direct

    // 2. A relative fragment — `Downloads\x\author\123.mp4` — against each root.
    if (!path.isAbsolute(value)) {
      const underRoots = this.roots.map((root) => path.resolve(root, value))
      const found = await firstFile(underRoots)
      if (found) return found
    }

    // 3. Name-only lookup: the whole point of this module.
    const hit = await this.lookupByName(basenameOf(value))
    if (hit) {
      logInfo(`[shortz] batch: "${value}" resolved by name -> ${hit}`)
      return hit
    }

    throw new Error(`File not found: ${value}${this.searchedHint()}`)
  }

  private searchedHint(): string {
    if (this.roots.length === 0) return ''
    return ` (also searched by name in ${this.roots.join(', ')})`
  }

  private async lookupByName(name: string): Promise<string | null> {
    await this.ensureIndex()
    const key = name.toLowerCase()
    let paths = this.byName?.get(key) ?? []
    // No extension typed: match `<id>.<video ext>` by stem. Any extension the
    // user DID type must match exactly — a typo should fail, not guess.
    if (paths.length === 0 && extensionOf(key).length === 0) {
      paths = this.byStem?.get(key) ?? []
    }
    if (paths.length === 0) return null

    // Same name in several author folders: the newest file is the one the
    // downloader just wrote, and the one a repost batch means.
    const candidates = await Promise.all(
      paths.map(async (file): Promise<Candidate> => {
        const stat = await fsp.stat(file).catch(() => null)
        return { file, mtimeMs: stat?.mtimeMs ?? 0 }
      })
    )
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return candidates[0]?.file ?? null
  }

  private ensureIndex(): Promise<void> {
    this.scan ??= this.buildIndex()
    return this.scan
  }

  private async buildIndex(): Promise<void> {
    const byName = new Map<string, string[]>()
    const byStem = new Map<string, string[]>()
    let budget = MAX_SCAN_ENTRIES

    for (const root of this.roots) {
      // Missing root = nothing to find there; a batch line may still resolve
      // through another root, so this is not an error.
      const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
      while (stack.length > 0 && budget > 0) {
        const current = stack.pop() as { dir: string; depth: number }
        const entries = await fsp.readdir(current.dir, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          budget -= 1
          if (budget <= 0) break
          const full = path.join(current.dir, entry.name)
          if (entry.isDirectory()) {
            if (current.depth < MAX_SCAN_DEPTH) stack.push({ dir: full, depth: current.depth + 1 })
            continue
          }
          // Symlinks are skipped on purpose: they cannot be trusted to stay
          // inside the root, and a loop would hang the walk.
          if (!entry.isFile()) continue
          const ext = extensionOf(entry.name)
          if (!(VIDEO_EXTENSIONS as readonly string[]).includes(ext)) continue
          push(byName, entry.name.toLowerCase(), full)
          push(byStem, stemOfName(entry.name), full)
        }
      }
    }

    this.byName = byName
    this.byStem = byStem
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Lowercased name without its extension (local copy — keeps this module standalone). */
function stemOfName(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase()
}

async function firstFile(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const stat = await fsp.stat(candidate).catch(() => null)
    if (stat?.isFile()) return candidate
  }
  return null
}
