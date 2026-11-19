import { describe, expect, it } from 'vitest'
import type { NarrationChunk } from '../../src/core/tts/chunks'
import {
  BREATH_MS,
  buildConcatList,
  CHUNK_DENOISE_FILTER,
  chunkProcessArgs,
  EDGE_FADE_SEC,
  gapMsAfter,
  masterTrimFilter,
  MASTER_FILTER,
  parseAudioMetricsLogs,
  planTrim,
  silenceArgs,
  wordTimeInChunk
} from '../../src/core/tts/postprocess'
import { NARRATION_GAP_MS } from '../../src/shared/tts/voices'

describe('planTrim', () => {
  it('keeps a 25ms breath buffer around the heard speech', () => {
    const trim = planTrim(
      [
        { word: 'Pertama,', start: 0.3, end: 0.8 },
        { word: 'kunci', start: 0.8, end: 1.1 }
      ],
      2.0
    )
    expect(trim.startSec).toBeCloseTo(0.3 - BREATH_MS / 1000, 4)
    expect(trim.durationSec).toBeCloseTo(1.1 + (BREATH_MS + 40) / 1000 - (0.3 - BREATH_MS / 1000), 4)
    expect(trim.speechStartSec).toBeCloseTo(BREATH_MS / 1000, 4)
  })

  it('never starts before zero or runs past the file', () => {
    const trim = planTrim([{ word: 'Hujan', start: 0.0, end: 0.4 }], 0.5)
    expect(trim.startSec).toBe(0)
    expect(trim.durationSec).toBeLessThanOrEqual(0.5)
  })

  it('falls back to the whole file when the ASR heard nothing', () => {
    const trim = planTrim([], 3.2)
    expect(trim).toEqual({ startSec: 0, durationSec: 3.2, speechStartSec: 0, speechEndSec: 3.2 })
  })
})

describe('chunkProcessArgs', () => {
  it('does not denoise, pace, or alter tag level for Gemini audio', () => {
    const args = chunkProcessArgs({ source: 'in.wav', output: 'out.wav',
      trim: planTrim([{ word: 'Halo', start: 0.1, end: 0.9 }], 1.2),
      pacing: 0.97, levelDb: -3, profile: 'gemini-tts' })
    const filter = args[args.indexOf('-af') + 1]!
    expect(filter).not.toContain('afftdn')
    expect(filter).not.toContain('atempo')
    expect(filter).not.toContain('volume=')
    expect(filter).toContain('afade=')
  })
  it('trims, denoises hiss, fades both edges in output time, and resamples', () => {
    const args = chunkProcessArgs({
      source: 'c0-a0.wav',
      output: 'p0.wav',
      trim: { startSec: 0.275, durationSec: 1.35, speechStartSec: 0.025, speechEndSec: 1.3 },
      pacing: 1.0
    })
    // Input seek + bounded read.
    expect(args).toContain('-ss')
    expect(args[args.indexOf('-ss') + 1]).toBe('0.2750')
    expect(args[args.indexOf('-t') + 1]).toBe('1.3500')
    const af = args[args.indexOf('-af') + 1]!
    // Vocoder hiss is removed per chunk, BEFORE the master's compressor.
    expect(af).toContain(CHUNK_DENOISE_FILTER)
    // No atempo when pacing is 1.0 — speed-ups distort timbre.
    expect(af).not.toContain('atempo')
    expect(af).toContain(`afade=t=in:st=0:d=${EDGE_FADE_SEC}`)
    expect(af).toContain('afade=t=out:st=1.3350')
    expect(af).toContain('aresample=48000')
    expect(args).toContain('pcm_s16le')
  })

  it('applies the tag level shaping (hook +0.5dB, twist −1.5dB)', () => {
    const hook = chunkProcessArgs({
      source: 'c.wav', output: 'p.wav',
      trim: { startSec: 0.1, durationSec: 2.0, speechStartSec: 0.15, speechEndSec: 1.9 },
      pacing: 1.0, levelDb: 0.5
    })
    expect(hook[hook.indexOf('-af') + 1]).toContain('volume=0.5dB')
    const twist = chunkProcessArgs({
      source: 'c.wav', output: 'p.wav',
      trim: { startSec: 0.1, durationSec: 2.0, speechStartSec: 0.15, speechEndSec: 1.9 },
      pacing: 0.97, levelDb: -1.5
    })
    const twistAf = twist[twist.indexOf('-af') + 1]!
    // The twist is the ONLY paced tag — subtle slow-down, never a speed-up.
    expect(twistAf).toContain('atempo=0.9700')
    expect(twistAf).toContain('volume=-1.5dB')
  })

  it('never produces a speed-up: pacing above 1 is not part of the design', () => {
    // Guard against regressing to 1.04-style robotic speed-ups.
    for (const pacing of [1.0, 0.97]) {
      const args = chunkProcessArgs({
        source: 'c.wav', output: 'p.wav',
        trim: { startSec: 0, durationSec: 1, speechStartSec: 0, speechEndSec: 1 },
        pacing
      })
      const af = args[args.indexOf('-af') + 1]!
      if (af.includes('atempo')) expect(af).toMatch(/atempo=0\.\d+/)
      expect(af).not.toMatch(/atempo=1\.(?!0{3}\b)\d/) // no 1.01–1.99 speed-ups
    }
  })
})

describe('gapMsAfter — deliberate silence pacing', () => {
  const chunk = (index: number, text: string, tag: NarrationChunk['tag']): NarrationChunk => ({
    index, text, tag
  })

  it('plain sentence break → 160ms', () => {
    expect(gapMsAfter(chunk(0, 'Hujan turun.', null), chunk(1, 'Kami diam.', null)))
      .toBe(NARRATION_GAP_MS.sentence)
    expect(NARRATION_GAP_MS.sentence).toBe(160)
  })

  it('new numbered step or [tactical] transition → 260ms', () => {
    expect(gapMsAfter(chunk(0, '…jangan keluar.', null), chunk(1, 'Kedua, matikan mesin.', null)))
      .toBe(NARRATION_GAP_MS.step)
    expect(gapMsAfter(chunk(0, 'Mereka melihatmu.', 'hook'), chunk(1, 'Pertama, kunci.', 'tactical')))
      .toBe(NARRATION_GAP_MS.step)
    expect(NARRATION_GAP_MS.step).toBe(260)
  })

  it('hook chunks are paced tight (100ms)', () => {
    expect(gapMsAfter(chunk(0, 'Dengar baik baik.', 'tactical'), chunk(1, 'Kalau kaca dikut.', 'hook')))
      .toBe(NARRATION_GAP_MS.hook)
    expect(gapMsAfter(chunk(0, 'Jangan bergerak.', 'hook'), chunk(1, 'Tetap rendah.', 'hook')))
      .toBe(NARRATION_GAP_MS.hook)
    expect(NARRATION_GAP_MS.hook).toBe(100)
  })

  it('the beat right before a [twist] reveal → 450ms', () => {
    expect(gapMsAfter(chunk(0, 'Kamu menahan napas.', 'tactical'), chunk(1, 'Yang mengetuk…', 'twist')))
      .toBe(NARRATION_GAP_MS.twistBeat)
    expect(NARRATION_GAP_MS.twistBeat).toBe(450)
  })

  it('twist-to-twist continues at sentence pace inside the reveal', () => {
    expect(gapMsAfter(chunk(0, 'Sunyi.', 'twist'), chunk(1, 'Lalu ketukan.', 'twist')))
      .toBe(NARRATION_GAP_MS.sentence)
  })
})

describe('stitch and master argv', () => {
  it('master chain: denoise pre-compression, peak-only compressor, limiter owns TP', () => {
    // Measured live: a −14dB program compressor crushed LRA 4.2 → 2.6. The
    // threshold sits above program level so it only catches peaks, and the
    // limiter owns the −1.4 dBFS true-peak ceiling (loudnorm headroom).
    expect(MASTER_FILTER).toBe(
      'highpass=f=85,' +
        'afftdn=nr=12:nf=-28:tn=1,' +
        'equalizer=f=140:t=q:w=1.2:g=2.5,' +
        'equalizer=f=450:t=q:w=1.5:g=-2.5,' +
        'equalizer=f=3200:t=q:w=1.2:g=1.5,' +
        'acompressor=threshold=-4dB:ratio=2.2:attack=10:release=80,' +
        'alimiter=limit=0.851:level=disabled'
    )
    // Order matters: denoise BEFORE the compressor so pumping can't amplify hiss.
    const denoiseAt = MASTER_FILTER.indexOf('afftdn=')
    const compressorAt = MASTER_FILTER.indexOf('acompressor=')
    const limiterAt = MASTER_FILTER.indexOf('alimiter=')
    expect(denoiseAt).toBeGreaterThan(-1)
    expect(denoiseAt).toBeLessThan(compressorAt)
    expect(compressorAt).toBeLessThan(limiterAt)
  })

  it('static trim gains to −14 with a peak limiter — no dynamic gain rider', () => {
    expect(masterTrimFilter(0.6)).toBe('volume=0.60dB,alimiter=limit=0.891:level=disabled')
    expect(masterTrimFilter(-2)).toBe('volume=-2.00dB,alimiter=limit=0.891:level=disabled')
    expect(masterTrimFilter(20)).toBe('volume=6.00dB,alimiter=limit=0.891:level=disabled') // clamped
    expect(masterTrimFilter(0)).toBe('volume=0.00dB,alimiter=limit=0.891:level=disabled')
  })

  it('silence gaps render at the stitch rate in PCM', () => {
    const args = silenceArgs('gap.wav', 0.5)
    expect(args[args.indexOf('-i') + 1]).toBe('anullsrc=r=48000:cl=mono')
    expect(args[args.indexOf('-t') + 1]).toBe('0.5000')
    expect(args).toContain('pcm_s16le')
  })

  it('ffconcat entries quote single quotes', () => {
    expect(buildConcatList(['a.wav', "it's.wav"])).toBe(
      "ffconcat version 1.0\nfile 'a.wav'\nfile 'it'\\''s.wav'\n"
    )
  })
})

describe('parseAudioMetricsLogs', () => {
  // Realistic ffmpeg stderr: per-frame lines (early LRA reads 0.0) then the
  // trailing Summary with the final values — the parser must not read frames.
  const loudnessLog = [
    '[Parsed_ebur128_0 @ x] t: 1      TARGET:-23 LUFS    M: -15.0 S: -16.2 I: -15.7 LUFS   LRA:   0.0 LU',
    '[Parsed_ebur128_0 @ x] t: 2      TARGET:-23 LUFS    M: -15.2 S: -16.3 I: -15.6 LUFS   LRA:   0.2 LU',
    '[Parsed_ebur128_0 @ x] Summary:',
    '',
    '  Integrated loudness:',
    '    I:         -14.3 LUFS',
    '    Threshold: -24.7 LUFS',
    '',
    '  Loudness range:',
    '    LRA:         5.8 LU',
    '    Threshold: -34.7 LUFS',
    '    LRA low:   -18.0 LUFS',
    '    LRA high:  -12.2 LUFS'
  ].join('\n')
  const statsLog = [
    '[Parsed_astats_0 @ x] Frame 1   RMS level dB: -14.1',
    '[Parsed_astats_0 @ x] Frame 2   RMS level dB: -16.8',
    '[Parsed_astats_0 @ x] Frame 3   RMS level dB: -inf',   // digital-zero gap
    '[Parsed_astats_0 @ x] Frame 4   RMS level dB: -95.3',  // gated (below -90)
    '[Parsed_astats_0 @ x] Frame 5   RMS level dB: -35.2'   // quietest voiced window
  ].join('\n')

  it('reads integrated/LRA from the Summary, never from per-frame lines', () => {
    const m = parseAudioMetricsLogs(loudnessLog, statsLog)
    expect(m.integratedLufs).toBeCloseTo(-14.3, 1)
    expect(m.loudnessRangeLu).toBeCloseTo(5.8, 1) // NOT the early 0.0 frame
  })

  it('estimates the noise floor from the quietest non-silent window', () => {
    const m = parseAudioMetricsLogs(loudnessLog, statsLog)
    expect(m.noiseFloorDbfs).toBe(-35.2) // -inf and -95.3 are gated out
  })

  it('returns nulls for logs without a summary', () => {
    expect(parseAudioMetricsLogs('no summary here', '')).toEqual({
      integratedLufs: null,
      loudnessRangeLu: null,
      noiseFloorDbfs: null
    })
  })
})

describe('wordTimeInChunk', () => {
  it('maps raw-synthesis word times onto the paced chunk timeline', () => {
    const trim = planTrim([{ word: 'Hujan', start: 0.5, end: 0.9 }], 2.0)
    // startSec = 0.475; word at 0.5 → 0.025 raw → /1.04 paced.
    expect(wordTimeInChunk(0.5, trim, 1.04)).toBeCloseTo(0.025 / 1.04, 5)
    expect(wordTimeInChunk(0.4, trim, 1.04)).toBe(0) // before the cut clamps to 0
  })
})
