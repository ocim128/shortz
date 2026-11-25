import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveTtsEnvironment, runTtsCommand } from '../../src/cli/tts'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

describe('tts provider voice selection', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('loads .env defaults with process environment precedence', async () => {
    const dir = await makeScratchDir('tts-env')
    try {
      const file = path.join(dir, '.env')
      const fallback = path.join(dir, 'api.env')
      await writeFile(file, 'SHORTZ_TTS_PROVIDER=gemini-tts\nGEMINI_API_KEY="test-only"\nGEMINI_API_KEY2=second\n')
      await writeFile(fallback, 'SHORTZ_TTS_PROVIDER=cloud\nGEMINI_API_KEY=fallback\nGEMINI_API_KEY3=third\n')
      expect(await resolveTtsEnvironment(file, {})).toEqual({ providerDefault: 'gemini-tts', geminiApiKeys: ['test-only', 'second'] })
      expect(await resolveTtsEnvironment(file, {}, fallback)).toEqual({ providerDefault: 'gemini-tts', geminiApiKeys: ['test-only', 'second', 'third'] })
      expect(await resolveTtsEnvironment(path.join(dir, 'missing'), {}, fallback)).toEqual({ providerDefault: 'cloud', geminiApiKeys: ['fallback', 'third'] })
      expect(await resolveTtsEnvironment(file, { SHORTZ_TTS_PROVIDER: 'edge', GEMINI_API_KEY: 'override' }))
        .toEqual({ providerDefault: 'edge', geminiApiKeys: ['override', 'second'] })
      expect(await resolveTtsEnvironment(path.join(dir, 'missing'), {}))
        .toEqual({ providerDefault: 'gemini-cloud', geminiApiKeys: [] })
    } finally { await removeScratchDir(dir) }
  })

  it('loads keys through number seven in numeric order across configuration sources', async () => {
    const dir = await makeScratchDir('tts-seven-keys')
    try {
      const file = path.join(dir, '.env')
      const fallback = path.join(dir, 'api.env')
      await writeFile(file, 'GEMINI_API_KEY2=two\nGEMINI_API_KEY7=seven\n')
      await writeFile(fallback, 'GEMINI_API_KEY=one\nGEMINI_API_KEY4=four\nGEMINI_API_KEY6=six\n')
      const result = await resolveTtsEnvironment(file, { GEMINI_API_KEY5: 'five' }, fallback)
      expect(result.geminiApiKeys).toEqual(['one', 'two', 'four', 'five', 'six', 'seven'])
    } finally { await removeScratchDir(dir) }
  })

  it('allows an explicit provider to override the environment default', async () => {
    vi.stubEnv('SHORTZ_TTS_PROVIDER', 'gemini-tts')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await runTtsCommand(['--provider', 'edge', '--list-voices'])).toBe(0)
    expect(log.mock.calls.some(([line]) => String(line).startsWith('rimba\t'))).toBe(true)
  })

  it('lists Gemini voices without requiring a key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await runTtsCommand(['--provider', 'gemini-tts', '--list-voices'])).toBe(0)
    const lines = log.mock.calls.map(([line]) => String(line))
    expect(lines[0]).toContain('Investigator')
    expect(lines.slice(1)).toEqual(['Charon', 'Fenrir', 'Orus', 'Algenib'])
  })

  it('lists Archipelago for Google Cloud without changing the Investigator default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(await runTtsCommand(['--provider', 'gemini-cloud', '--list-voices'])).toBe(0)
    const lines = log.mock.calls.map(([line]) => String(line))
    expect(lines[0]).toContain('Investigator')
    expect(lines.some((line) => line.startsWith('archipelago\tArchipelago\t'))).toBe(true)
  })

  it('rejects an invalid project key index before generation', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key')
    vi.stubEnv('GEMINI_API_KEY2', '')
    vi.stubEnv('GEMINI_API_KEY3', '')
    vi.stubEnv('GEMINI_API_KEY4', '')
    vi.stubEnv('GEMINI_API_KEY5', '')
    vi.stubEnv('GEMINI_API_KEY6', '')
    vi.stubEnv('GEMINI_API_KEY7', '')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await runTtsCommand(['--provider', 'gemini-tts', '--voice', 'voice_abc123', '--gemini-key-index', '2', '--text', 'Halo', '--output', 'out.mp3'])).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('key index is not configured'))
  })

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
