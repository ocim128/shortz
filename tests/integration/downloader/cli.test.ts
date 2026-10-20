import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDataDir, defaultOutputDir, parseDlArgs, runDlCommand } from '../../../src/cli/dl'
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
const URL_ = `https://x.com/someuser/status/${SINGLE}`

let root: string
let dataDir: string
let outDir: string
let stdout: string[]
let stderr: string[]

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shortz-cli-'))
  dataDir = path.join(root, 'data')
  outDir = path.join(root, 'out')
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await fs.rm(root, { recursive: true, force: true })
})

/** A media body that sends one chunk and then never finishes, so a cancel lands mid-transfer. */
function slowMediaRoute(bytes: Uint8Array): FakeRoute {
  return {
    match: (url: string) => url.startsWith('https://video.twimg.com/'),
    respond: () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 512))
        }
      })
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(bytes.byteLength)
        }
      })
    }
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condition not met before the deadline')
}

function routes() {
  return [
    {
      match: 'cdn.syndication.twimg.com/tweet-result',
      respond: () => jsonResponse(readFixtureBody('syndication/single-video.json'))
    },
    rangeMediaRoute(fakeVideoBytes(2048)),
    posterRoute()
  ]
}

describe('dl command — argument grammar (D-A19)', () => {
  it('defaults to the app data dir and the user Videos folder', () => {
    expect(defaultOutputDir()).toBe(path.join(os.homedir(), 'Videos', 'ShortZ', 'Downloads'))
    expect(defaultDataDir().endsWith(path.join('shortz'))).toBe(true)
  })

  it('parses the documented flags', () => {
    const options = parseDlArgs([
      'https://x.com/a/status/1',
      '--out',
      'C:\\videos',
      '--layout',
      'by-date',
      '--template',
      '{author}_{id}',
      '--quality',
      'max:720',
      '--fallback',
      'fxtwitter',
      '--concurrency',
      '2',
      '--dry-run',
      '--force',
      '--no-sidecars',
      '--json'
    ])
    expect(options.linkArgs).toEqual(['https://x.com/a/status/1'])
    expect(options.layout).toBe('by-date')
    expect(options.template).toBe('{author}_{id}')
    expect(options.quality).toEqual({ maxHeight: 720 })
    expect(options.fallback).toBe('fxtwitter')
    expect(options.concurrency).toBe(2)
    expect(options.dryRun).toBe(true)
    expect(options.force).toBe(true)
    expect(options.sidecars).toBe(false)
    expect(options.json).toBe(true)
  })

  it('rejects nonsense instead of guessing', () => {
    expect(() => parseDlArgs(['--layout', 'sideways', 'x'])).toThrow(/layout/)
    expect(() => parseDlArgs(['--quality', 'huge', 'x'])).toThrow(/quality/)
    expect(() => parseDlArgs(['--concurrency', '9', 'x'])).toThrow(/concurrency/)
    expect(() => parseDlArgs(['--nope'])).toThrow(/Unknown option/)
    expect(() => parseDlArgs([])).toThrow(/No links/)
  })

  it('exit code 2 and usage on a usage error, 0 on --help', async () => {
    expect(await runDlCommand([])).toBe(2)
    expect(stdout.join('')).toContain('Usage')
    stdout = []
    expect(await runDlCommand(['--help'])).toBe(0)
    expect(stdout.join('')).toContain('shortz dl')
  })
})

describe('dl command — end to end', () => {
  it('--dry-run prints author, caption, dims, chosen variant and the planned path', async () => {
    vi.stubGlobal('fetch', fakeFetch(routes()))
    const code = await runDlCommand([URL_, '--dry-run', '--out', outDir, '--data', dataDir])

    const out = stdout.join('')
    expect(code).toBe(0)
    expect(out).toContain(`planned ${SINGLE}`)
    expect(out).toContain('@someuser')
    expect(out).toContain('A single video post')
    expect(out).toContain('1280x720')
    expect(out).toContain('2176 kbps')
    expect(out).toContain('video/mp4')
    expect(out).toContain('https://video.twimg.com/v/single-2176.mp4')
    expect(out).toContain(path.join(outDir, 'x', 'someuser', `${SINGLE}.mp4`))
    expect(out).toContain('Done: 1 line(s)')

    // Analyze wrote nothing.
    await expect(fs.stat(path.join(dataDir, 'downloads', 'state.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(
      fs.stat(path.join(outDir, 'x', 'someuser', `${SINGLE}.mp4`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('downloads when the dry-run flag is absent, and the second run skips', async () => {
    const fake = fakeFetch(routes())
    vi.stubGlobal('fetch', fake)

    expect(await runDlCommand([URL_, '--out', outDir, '--data', dataDir])).toBe(0)
    const dest = path.join(outDir, 'x', 'someuser', `${SINGLE}.mp4`)
    expect((await fs.stat(dest)).size).toBe(2048)
    expect(stdout.join('')).toContain('1 file(s)')

    const before = fake.calls.length
    stdout = []
    expect(await runDlCommand([URL_, '--out', outDir, '--data', dataDir])).toBe(0)
    expect(stdout.join('').toLowerCase()).toContain('skipped (already downloaded')
    expect(fake.calls.length).toBe(before)
  })

  it('reads links from a file and from --id', async () => {
    vi.stubGlobal('fetch', fakeFetch(routes()))
    const list = path.join(root, 'links.txt')
    await fs.writeFile(list, `\n${URL_}\n\n`)

    expect(await runDlCommand([list, '--dry-run', '--out', outDir, '--data', dataDir])).toBe(0)
    expect(stdout.join('')).toContain(`planned ${SINGLE}`)

    stdout = []
    expect(
      await runDlCommand(['--id', SINGLE, '--dry-run', '--out', outDir, '--data', dataDir])
    ).toBe(0)
    expect(stdout.join('')).toContain(`planned ${SINGLE}`)
  })

  it('--json emits NDJSON, one object per line', async () => {
    vi.stubGlobal('fetch', fakeFetch(routes()))
    expect(
      await runDlCommand([URL_, '--dry-run', '--json', '--out', outDir, '--data', dataDir])
    ).toBe(0)
    const lines = stdout.join('').trim().split('\n')
    const parsed = lines.map((line) => JSON.parse(line) as { kind: string })
    expect(parsed.some((event) => event.kind === 'item')).toBe(true)
    expect(parsed.at(-1)?.kind).toBe('run-done')
  })

  it('exits 1 when a line cannot be resolved', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch([
        { match: 'cdn.syndication.twimg.com', respond: () => new Response(null, { status: 404 }) }
      ])
    )
    const code = await runDlCommand([URL_, '--out', outDir, '--data', dataDir])
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('failed')
    expect(stdout.join('')).toContain('Done: 1 line(s)')
  })

  it('Ctrl+C keeps the .part + validator and exits 130', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch([
        {
          match: 'cdn.syndication.twimg.com',
          respond: () => jsonResponse(readFixtureBody('syndication/single-video.json'))
        },
        slowMediaRoute(fakeVideoBytes(64 * 1024)),
        posterRoute()
      ])
    )

    const running = runDlCommand([URL_, '--out', outDir, '--data', dataDir])
    const dest = path.join(outDir, 'x', 'someuser', `${SINGLE}.mp4`)
    const part = `${dest}.part`
    await waitFor(async () => {
      try {
        return (await fs.stat(part)).size > 0
      } catch {
        return false
      }
    })

    process.emit('SIGINT')
    expect(await running).toBe(130)

    // The bytes and the resume validator survive; no final file appears.
    expect((await fs.stat(part)).size).toBeGreaterThan(0)
    expect((await fs.stat(`${part}.json`)).size).toBeGreaterThan(0)
    await expect(fs.stat(dest)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(stderr.join('')).toContain('cancelling')
  })

  it('--retry-failed needs no links and picks up the failed row', async () => {
    const fake = fakeFetch(routes())
    vi.stubGlobal('fetch', fake)
    // First run fails (no media route), so the state index has a failed row.
    vi.stubGlobal(
      'fetch',
      fakeFetch([
        {
          match: 'cdn.syndication.twimg.com',
          respond: () => jsonResponse(readFixtureBody('syndication/single-video.json'))
        },
        { match: 'video.twimg.com', respond: () => new Response(null, { status: 500 }) },
        posterRoute()
      ])
    )
    expect(await runDlCommand([URL_, '--out', outDir, '--data', dataDir])).toBe(1)

    vi.stubGlobal('fetch', fake)
    stdout = []
    const code = await runDlCommand(['--retry-failed', '--out', outDir, '--data', dataDir])
    expect(code).toBe(0)
    expect(stdout.join('')).toContain('1 file(s)')
  })
})
