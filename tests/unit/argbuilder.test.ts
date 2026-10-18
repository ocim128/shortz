import { describe, expect, it } from 'vitest'
import {
  buildFfmpegArgs,
  buildFilterComplex,
  formatSeconds,
  type BuildArgsInput
} from '../../src/core/ffmpeg/argbuilder'
import { resolveLayout } from '../../src/shared/layout/engine'
import type { KnobId } from '../../src/shared/template/knob-registry'
import { loadFont, loadHookTemplate } from '../helpers/env'

function layoutFor(
  clip: { width: number; height: number },
  knobs: Partial<Record<KnobId, unknown>> = {}
) {
  return resolveLayout({
    template: loadHookTemplate(),
    values: { fields: { hook: 'Hello world' }, knobs },
    clip,
    loadFont
  })
}

function baseInput(overrides: Partial<BuildArgsInput> = {}): BuildArgsInput {
  return {
    source: 'in.mp4',
    layout: layoutFor({ width: 1920, height: 1080 }),
    overlayPath: 'overlay.png',
    outputPath: 'out.mp4',
    durationSec: 10,
    fps: 30,
    encoder: 'libx264',
    crf: 18,
    audio: 'keep',
    hasAudio: true,
    ...overrides
  }
}

describe('formatSeconds', () => {
  it('rounds to milliseconds and clamps negatives', () => {
    expect(formatSeconds(7)).toBe('7')
    expect(formatSeconds(7.0005)).toBe('7.001')
    expect(formatSeconds(0.1234)).toBe('0.123')
    expect(formatSeconds(-3)).toBe('0')
  })
})

describe('buildFfmpegArgs — audio semantics', () => {
  it('keeps and re-encodes audio to stereo AAC 48k', () => {
    const args = buildFfmpegArgs(baseInput())
    const joined = args.join(' ')
    expect(joined).toContain('-map 0:a?')
    expect(joined).toContain('-c:a aac -b:a 192k -ac 2 -ar 48000')
    expect(args).not.toContain('-an')
  })

  it('mutes with -an and no audio codec flags', () => {
    const args = buildFfmpegArgs(baseInput({ audio: 'mute' }))
    expect(args).toContain('-an')
    expect(args.join(' ')).not.toContain('-c:a')
  })

  it('emits no audio flags at all when the source has no audio stream', () => {
    const args = buildFfmpegArgs(baseInput({ hasAudio: false }))
    const joined = args.join(' ')
    expect(joined).not.toContain('-an')
    expect(joined).not.toContain('-c:a')
    expect(joined).not.toContain('0:a')
  })
})

describe('buildFfmpegArgs — encode and trim', () => {
  it('encodes h264 crf18 veryfast with faststart and stable tail', () => {
    const args = buildFfmpegArgs(baseInput())
    const joined = args.join(' ')
    expect(joined).toContain('-c:v libx264 -crf 18 -preset veryfast')
    expect(joined).toContain('-movflags +faststart')
    expect(joined).toContain('-map [outv]')
    expect(args[args.length - 1]).toBe('out.mp4')
  })

  it('applies trim with -ss/-t before the input', () => {
    const args = buildFfmpegArgs(baseInput({ trim: { start: 1, end: 8 }, durationSec: 7 }))
    const ss = args.indexOf('-ss')
    expect(ss).toBeGreaterThan(-1)
    expect(args[ss + 1]).toBe('1')
    expect(args[args.indexOf('-t') + 1]).toBe('7')
  })

  it('supports nvenc', () => {
    const args = buildFfmpegArgs(baseInput({ encoder: 'h264_nvenc' }))
    expect(args.join(' ')).toContain('-c:v h264_nvenc')
  })
})

describe('buildFfmpegArgs — static inputs', () => {
  it('decodes the overlay PNG once instead of at the output fps', () => {
    const args = buildFfmpegArgs(baseInput())
    expect(args.join(' ')).toContain('-loop 1 -framerate 1 -i overlay.png')
  })
})

describe('buildFfmpegArgs — background cases', () => {
  it('draws a solid color base for case A', () => {
    const filter = buildFilterComplex(baseInput())
    expect(filter).toContain('color=c=black:s=1080x1920:r=30:d=10')
    expect(filter).toContain('overlay=0:520:shortest=1')
    expect(filter).not.toContain('gblur')
  })

  it('uses white for the white knob', () => {
    const input = baseInput({
      layout: layoutFor({ width: 1920, height: 1080 }, { backgroundStyle: 'white' })
    })
    expect(buildFilterComplex(input)).toContain('color=c=white')
  })

  it('blurs a scaled copy and merges the rounded-corner mask (case B2)', () => {
    const input = baseInput({
      layout: layoutFor({ width: 1920, height: 1080 }, { backgroundStyle: 'blurVideo' }),
      maskPath: 'mask.png'
    })
    const filter = buildFilterComplex(input)
    expect(filter).toContain('gblur=sigma=30')
    expect(filter).toContain('eq=brightness=-0.05')
    expect(filter).toContain('[2:v]format=gray[mask]')
    expect(filter).toContain('alphamerge')
    const args = buildFfmpegArgs(input)
    const joined = args.join(' ')
    expect(joined).toContain('-loop 1 -framerate 30 -i mask.png')
  })

  it('omits the mask input for blur without rounding', () => {
    const input = baseInput({
      layout: layoutFor({ width: 1920, height: 1080 }, { backgroundStyle: 'blurVideo' })
    })
    const filter = buildFilterComplex(input)
    expect(filter).not.toContain('alphamerge')
    expect(buildFfmpegArgs(input).join(' ')).not.toContain('mask.png')
  })

  it('pins the differing video rect into the overlay call', () => {
    const portrait = buildFilterComplex(
      baseInput({ layout: layoutFor({ width: 1080, height: 1920 }) })
    )
    expect(portrait).toContain('scale=551:980')
    expect(portrait).toContain('overlay=265:520:shortest=1')
  })
})

describe('buildFfmpegArgs — video framing (cover/contain)', () => {
  it('contain scales straight to the rect (aspect already matches)', () => {
    const filter = buildFilterComplex(baseInput())
    expect(filter).toContain('scale=1080:608:flags=lanczos,setsar=1')
    expect(filter).not.toContain('force_original_aspect_ratio')
  })

  it('fill cover-scales and center-crops to the safe box', () => {
    const input = baseInput({ layout: layoutFor({ width: 1920, height: 1080 }, { videoFraming: 'fill' }) })
    const filter = buildFilterComplex(input)
    expect(filter).toContain(
      'scale=1080:980:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:980,setsar=1'
    )
  })

  it('fill keeps the cover chain on the blur background path too', () => {
    const input = baseInput({
      layout: layoutFor(
        { width: 1920, height: 1080 },
        { videoFraming: 'fill', backgroundStyle: 'blurVideo' }
      )
    })
    const filter = buildFilterComplex(input)
    expect(filter).toContain('crop=1080:980,setsar=1')
    expect(filter).toContain('[bg]')
  })
})
