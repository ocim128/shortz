import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runFfmpeg } from '../../src/core/ffmpeg/runner'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

/**
 * A stand-in "ffmpeg": a node script that stays alive but prints nothing, so
 * no -progress lines ever arrive and the stall watchdog must kill it. It is a
 * FILE (not -e) so the args runFfmpeg appends (-progress pipe:1 -nostats)
 * land in process.argv instead of tripping node's own option parser.
 */
let stalledFfmpegPath = ''
let scratchDir = ''

beforeAll(async () => {
  scratchDir = await makeScratchDir('runner')
  stalledFfmpegPath = path.join(scratchDir, 'stalled-ffmpeg.cjs')
  await writeFile(stalledFfmpegPath, 'setInterval(() => {}, 60000)\n', 'utf8')
})

afterAll(async () => {
  if (scratchDir) await removeScratchDir(scratchDir)
})

describe('runFfmpeg — stall escalation', () => {
  it(
    'kills a process that emits no progress and settles as stalled',
    { timeout: 20_000 },
    async () => {
      const run = await runFfmpeg({
        ffmpegPath: process.execPath,
        args: [stalledFfmpegPath],
        durationSec: 1,
        stallTimeoutMs: 500
      })
      expect(run.stalled).toBe(true)
      expect(run.cancelled).toBe(false)
      expect(run.code).not.toBe(0)
      expect(run.elapsedMs).toBeLessThan(15_000)
    }
  )
})
