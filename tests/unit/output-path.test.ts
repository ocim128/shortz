import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOutputPath, sanitizeNamePart } from '../../src/main/output-path'

const NOW = new Date(2026, 9, 18, 9, 35, 0) // 2026-10-18 09:35 local

describe('output path tokens', () => {
  it('expands the documented default pattern', () => {
    const out = buildOutputPath({
      dir: 'C:\\out',
      pattern: '{name}_{yyyyMMdd}_{HHmm}',
      name: 'tupai',
      templateId: 'hook-letterbox',
      now: NOW
    })
    expect(out).toBe(path.join('C:\\out', 'tupai_20261018_0935.mp4'))
  })

  it('expands {template} and {seq}', () => {
    const out = buildOutputPath({
      dir: 'C:\\out',
      pattern: '{seq}_{template}_{name}',
      name: 'tupai',
      templateId: 'hook-letterbox',
      seq: 4,
      now: NOW
    })
    expect(out).toBe(path.join('C:\\out', '4_hook-letterbox_tupai.mp4'))
  })

  it('defaults seq to 1 like the single-project export', () => {
    const out = buildOutputPath({
      dir: 'C:\\out',
      pattern: '{seq}',
      name: 'x',
      templateId: 't',
      now: NOW
    })
    expect(out).toBe(path.join('C:\\out', '1.mp4'))
  })

  it('strips characters Windows rejects in filenames', () => {
    const out = buildOutputPath({
      dir: 'C:\\out',
      pattern: '{name}',
      name: 'a:b?c*d"e<f>g|h',
      templateId: 't',
      now: NOW
    })
    expect(path.basename(out)).toBe('a_b_c_d_e_f_g_h.mp4')
  })

  it('keeps unknown tokens verbatim instead of dropping them', () => {
    const out = buildOutputPath({
      dir: 'C:\\out',
      pattern: 'x-{unknown}-{name}',
      name: 'clip',
      templateId: 't',
      now: NOW
    })
    expect(path.basename(out)).toBe('x-{unknown}-clip.mp4')
  })

  it('falls back to "export" when the pattern collapses to nothing', () => {
    const out = buildOutputPath({
      dir: 'C:\\out',
      pattern: '__',
      name: 'clip',
      templateId: 't',
      now: NOW
    })
    expect(path.basename(out)).toBe('export.mp4')
  })

  it('trims the sanitized name so patterns do not leave dangling separators', () => {
    expect(sanitizeNamePart('  clip  ')).toBe('clip')
    expect(sanitizeNamePart('a/b')).toBe('a_b')
  })
})
