import { afterEach, describe, expect, it, vi } from 'vitest'
import { runTtsCommand } from '../../src/cli/tts'

describe('tts provider voice selection', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lists the selected provider’s voices', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await runTtsCommand(['--provider', 'edge', '--list-voices'])).toBe(0)
    const lines = log.mock.calls.map(([line]) => String(line))
    expect(lines.some((line) => line.startsWith('rimba\t'))).toBe(true)
    expect(lines.some((line) => line.startsWith('jejak\t'))).toBe(false)
  })

  it('rejects a VoxCPM voice when Edge is selected', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runTtsCommand(['--provider', 'edge', '--voice', 'jejak', '--text', 'Halo', '--output', 'out.mp3'])).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Unknown voice: jejak'))
  })
})
