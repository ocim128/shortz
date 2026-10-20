/**
 * Record a real payload into `tests/fixtures/downloader/` — opt-in only.
 *
 * The committed fixtures are hand-written minimal payloads (D-A18), because a
 * real post carries a real caption and personal data. This recorder exists for
 * the day the endpoint changes shape and a fresh payload is needed:
 *
 *   pnpm exec tsx scripts/record-dl-fixture.ts <x-url-or-id> [options]
 *
 *   --adapter syndication|fxtwitter|both   (default: syndication)
 *   --out <name>                           file stem (default: <tweetId>)
 *   --include-caption                      keep the real text (never commit
 *                                          this without the author's blessing)
 *   --force                                overwrite an existing fixture
 *
 * By default the caption is replaced with an empty string and a `__note`
 * explains why. A non-2xx response is recorded as `{"__status": <code>}`, which
 * is exactly what `readFixture()` in the test helpers understands.
 *
 * This script is outside every tsconfig; it is run with tsx and is not part of
 * `pnpm typecheck:core`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fxTwitterUrl } from '../src/core/downloader/resolve/fxtwitter'
import { syndicationUrl } from '../src/core/downloader/resolve/syndication'
import { parseStatusUrl } from '../src/shared/downloader/urls'

const ROOT = path.resolve(__dirname, '..', 'tests', 'fixtures', 'downloader')
const USER_AGENT = 'ShortZ/0.0.1 fixture recorder (+local desktop app)'

type Adapter = 'syndication' | 'fxtwitter'

interface Args {
  input: string
  adapters: Adapter[]
  out: string | null
  includeCaption: boolean
  force: boolean
}

function usage(): never {
  process.stderr.write(
    'Usage: pnpm exec tsx scripts/record-dl-fixture.ts <x-url-or-id> ' +
      '[--adapter syndication|fxtwitter|both] [--out <name>] ' +
      '[--include-caption] [--force]\n'
  )
  process.exit(2)
}

function parseArgs(argv: string[]): Args {
  let input: string | null = null
  let adapter: 'syndication' | 'fxtwitter' | 'both' = 'syndication'
  let out: string | null = null
  let includeCaption = false
  let force = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg === '--adapter') {
      const value = argv[index + 1]
      if (value !== 'syndication' && value !== 'fxtwitter' && value !== 'both') usage()
      adapter = value
      index += 1
    } else if (arg === '--out') {
      const value = argv[index + 1]
      if (value === undefined) usage()
      out = value
      index += 1
    } else if (arg === '--include-caption') {
      includeCaption = true
    } else if (arg === '--force') {
      force = true
    } else if (arg === '-h' || arg === '--help') {
      usage()
    } else if (arg.startsWith('-')) {
      usage()
    } else if (input === null) {
      input = arg
    } else {
      usage()
    }
  }

  if (input === null) usage()
  return {
    input,
    adapters: adapter === 'both' ? ['syndication', 'fxtwitter'] : [adapter],
    out,
    includeCaption,
    force
  }
}

/** The id from a status URL, or a bare id (`--id`-style) for convenience. */
function tweetIdOf(input: string): string {
  try {
    return parseStatusUrl(input, { allowBareId: true }).tweetId
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
}

function endpointFor(adapter: Adapter, tweetId: string): string {
  return adapter === 'syndication' ? syndicationUrl(tweetId) : fxTwitterUrl(tweetId)
}

/** Remove the one field we never commit by default. */
function scrubCaption(adapter: Adapter, payload: unknown, includeCaption: boolean): unknown {
  if (typeof payload !== 'object' || payload === null) return payload
  const root = { ...(payload as Record<string, unknown>) }
  if (adapter === 'syndication') {
    if (!includeCaption && 'text' in root) {
      root.text = ''
      root.__note = 'caption removed by record-dl-fixture; pass --include-caption to keep it'
    }
    return root
  }
  const tweet = root.tweet
  if (typeof tweet === 'object' && tweet !== null) {
    const copy = { ...(tweet as Record<string, unknown>) }
    if (!includeCaption && 'text' in copy) {
      copy.text = ''
      root.__note = 'caption removed by record-dl-fixture; pass --include-caption to keep it'
    }
    root.tweet = copy
  }
  return root
}

async function record(adapter: Adapter, args: Args, tweetId: string): Promise<string> {
  const name = args.out ?? tweetId
  const target = path.join(ROOT, adapter, `${name}.json`)
  if (existsSync(target) && !args.force) {
    throw new Error(`${path.relative(process.cwd(), target)} exists (use --force to overwrite)`)
  }

  const response = await fetch(endpointFor(adapter, tweetId), {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    redirect: 'manual'
  })
  const text = await response.text()

  let recorded: unknown
  if (response.status < 200 || response.status >= 300) {
    recorded = {
      __status: response.status,
      __note: `live response for ${adapter} on ${new Date().toISOString()}`
    }
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`${adapter} returned ${response.status} but not JSON`)
    }
    recorded = scrubCaption(adapter, parsed, args.includeCaption)
  }

  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(recorded, null, 2)}\n`, 'utf8')
  return target
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const tweetId = tweetIdOf(args.input)
  process.stdout.write(`tweet ${tweetId}\n`)
  for (const adapter of args.adapters) {
    const target = await record(adapter, args, tweetId)
    process.stdout.write(
      `wrote ${path.relative(process.cwd(), target)}${args.includeCaption ? ' (caption kept!)' : ''}\n`
    )
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `record-dl-fixture: ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(1)
})
