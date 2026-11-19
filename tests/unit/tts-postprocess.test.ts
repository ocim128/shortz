import { describe, expect, it } from 'vitest'
import type { NarrationChunk } from '../../src/core/tts/chunks'
import {
  BREATH_MS,
  buildConcatList,
  chunkProcessArgs,
  EDGE_FADE_SEC,
  gapMsAfter,
  MASTER_FILTER,
  planTrim,
  silenceArgs,
  stitchArgs,
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
    expect(trim.durationSec).toBeCloseTo(1.1 + BREATH_MS / 1000 - (0.3 - BREATH_MS / 1000), 4)
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
  it('trims, paces, fades both edges in output time, and resamples', () => {
    const args = chunkProcessArgs({
      source: 'c0-a0.wav',
      output: 'p0.wav',
      trim: { startSec: 0.275, durationSec: 1.35, speechStartSec: 0.025, speechEndSec: 1.3 },
      pacing: 1.04
    })
    // Input seek + bounded read.
    expect(args).toContain('-ss')
    expect(args[args.indexOf('-ss') + 1]).toBe('0.2750')
    expect(args[args.indexOf('-t') + 1]).toBe('1.3500')
    const af = args[args.indexOf('-af') + 1]!
    expect(af).toContain('atempo=1.0400')
    expect(af).toContain(`afade=t=in:st=0:d=${EDGE_FADE_SEC}`)
    // 1.35 / 1.04 ≈ 1.2981 → fade-out starts 15ms before the end.
    expect(af).toContain('afade=t=out:st=1.2831')
    expect(af).toContain('aresample=48000')
    expect(args).toContain('pcm_s16le')
  })

  it('slows the twist delivery (0.92) with the same edge guarantees', () => {
    const args = chunkProcessArgs({
      source: 'c.wav',
      output: 'p.wav',
      trim: { startSec: 0.1, durationSec: 2.0, speechStartSec: 0.15, speechEndSec: 1.9 },
      pacing: 0.92
    })
    expect(args[args.indexOf('-af') + 1]).toContain('atempo=0.9200')
  })
})

describe('gapMsAfter — deliberate silence pacing', () => {
  const chunk = (index: number, text: string, tag: NarrationChunk['tag']): NarrationChunk => ({
    index, text, tag
  })

  it('plain sentence break → 140ms', () => {
    expect(gapMsAfter(chunk(0, 'Hujan turun.', null), chunk(1, 'Kami diam.', null)))
      .toBe(NARRATION_GAP_MS.sentence)
  })

  it('new numbered step → 280ms', () => {
    expect(gapMsAfter(chunk(0, '…jangan keluar.', null), chunk(1, 'Kedua, matikan mesin.', null)))
      .toBe(NARRATION_GAP_MS.step)
  })

  it('a [tactical] transition → 280ms', () => {
    expect(gapMsAfter(chunk(0, 'Mereka melihatmu.', 'hook'), chunk(1, 'Pertama, kunci.', 'tactical')))
      .toBe(NARRATION_GAP_MS.step)
  })

  it('the beat right before a [twist] reveal → 500ms', () => {
    expect(gapMsAfter(chunk(0, 'Kamu menahan napas.', 'tactical'), chunk(1, 'Yang mengetuk…', 'twist')))
      .toBe(NARRATION_GAP_MS.twistBeat)
  })

  it('twist-to-twist continues at sentence pace inside the reveal', () => {
    expect(gapMsAfter(chunk(0, 'Sunyi.', 'twist'), chunk(1, 'Lalu ketukan.', 'twist')))
      .toBe(NARRATION_GAP_MS.sentence)
  })
})

describe('stitch and master argv', () => {
  it('master on: the fixed broadcast chain runs before the MP3 encode', () => {
    const args = stitchArgs({ listFile: 'list.ffconcat', output: 'narration.mp3', master: true })
    expect(args).toEqual([
      '-y', '-f', 'concat', '-safe', '0', '-i', 'list.ffconcat',
      '-af', MASTER_FILTER,
      '-ar', '48000',
      '-c:a', 'libmp3lame', '-q:a', '2', 'narration.mp3'
    ])
    expect(MASTER_FILTER).toBe(
      'highpass=f=80,' +
        'equalizer=f=140:t=q:w=1.2:g=3,' +
        'equalizer=f=450:t=q:w=1.5:g=-2.5,' +
        'equalizer=f=3200:t=q:w=1.2:g=2,' +
        'acompressor=threshold=-18dB:ratio=3:attack=5:release=60,' +
        'loudnorm=I=-14:TP=-1.0:LRA=7'
    )
  })

  it('master off: plain concat + MP3 encode', () => {
    expect(stitchArgs({ listFile: 'l', output: 'o.mp3', master: false })).not.toContain('-af')
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

describe('wordTimeInChunk', () => {
  it('maps raw-synthesis word times onto the paced chunk timeline', () => {
    const trim = planTrim([{ word: 'Hujan', start: 0.5, end: 0.9 }], 2.0)
    // startSec = 0.475; word at 0.5 → 0.025 raw → /1.04 paced.
    expect(wordTimeInChunk(0.5, trim, 1.04)).toBeCloseTo(0.025 / 1.04, 5)
    expect(wordTimeInChunk(0.4, trim, 1.04)).toBe(0) // before the cut clamps to 0
  })
})
