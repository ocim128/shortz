import { describe, expect, it } from 'vitest'
import {
  BATCH_SEPARATOR,
  basenameOf,
  extensionOf,
  hookFieldKeyOf,
  isVideoPath,
  normalizeBatchPath,
  parseBatchText,
  stemOf
} from '../../src/shared/batch/parse'

const SAMPLE = `C:\\Users\\user\\Videos\\ShortZ\\tupai.mp4${BATCH_SEPARATOR}TUPAI YG LUCU`

describe('batch line parsing', () => {
  it('parses the documented single-line example', () => {
    const lines = parseBatchText(SAMPLE)
    expect(lines).toHaveLength(1)
    const line = lines[0]!
    expect(line.path).toBe('C:\\Users\\user\\Videos\\ShortZ\\tupai.mp4')
    expect(line.hook).toBe('TUPAI YG LUCU')
    expect(line.hasSeparator).toBe(true)
    expect(line.problems).toEqual([])
    expect(line.index).toBe(0)
    expect(line.lineNumber).toBe(1)
  })

  it('parses one item per line and keeps hooks separate', () => {
    const text = [
      SAMPLE,
      `C:\\clips\\kucing.mp4${BATCH_SEPARATOR}KUCING YG MALAS`,
      `D:\\anak.mp4${BATCH_SEPARATOR}ANAK YG LUCU SEKALI`
    ].join('\n')
    const lines = parseBatchText(text)
    expect(lines.map((l) => l.hook)).toEqual([
      'TUPAI YG LUCU',
      'KUCING YG MALAS',
      'ANAK YG LUCU SEKALI'
    ])
    expect(lines.map((l) => l.index)).toEqual([0, 1, 2])
    expect(lines.every((l) => l.problems.length === 0)).toBe(true)
  })

  it('handles CRLF line endings from Windows paste', () => {
    const text = `${SAMPLE}\r\nC:\\b\\two.mp4${BATCH_SEPARATOR}SECOND\r\n`
    const lines = parseBatchText(text)
    expect(lines).toHaveLength(2)
    expect(lines[1]!.hook).toBe('SECOND')
    expect(lines[1]!.path).toBe('C:\\b\\two.mp4')
  })

  it('skips blank lines without shifting the queue indices', () => {
    const text = `\n\n${SAMPLE}\n   \nC:\\b\\two.mp4${BATCH_SEPARATOR}SECOND\n\n`
    const lines = parseBatchText(text)
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.index)).toEqual([0, 1])
    // lineNumber still reports the true textarea line for error messages.
    expect(lines[0]!.lineNumber).toBe(3)
    expect(lines[1]!.lineNumber).toBe(5)
  })

  it('strips double quotes from Explorer "Copy as path"', () => {
    const lines = parseBatchText(`"C:\\clips\\a b.mp4"${BATCH_SEPARATOR}HOOK`)
    expect(lines[0]!.path).toBe('C:\\clips\\a b.mp4')
    expect(lines[0]!.problems).toEqual([])
  })

  it('keeps bullets typed inside the hook text', () => {
    const lines = parseBatchText(`C:\\clips\\a.mp4${BATCH_SEPARATOR}ONE • TWO • THREE`)
    expect(lines[0]!.path).toBe('C:\\clips\\a.mp4')
    expect(lines[0]!.hook).toBe('ONE • TWO • THREE')
  })

  it('splits on the separator after a folder name that contains a bullet', () => {
    const lines = parseBatchText(`C:\\clips\\a•b\\clip.mp4${BATCH_SEPARATOR}HOOK`)
    expect(lines[0]!.path).toBe('C:\\clips\\a•b\\clip.mp4')
    expect(lines[0]!.hook).toBe('HOOK')
  })

  it('accepts forward slashes and uppercase extensions', () => {
    const lines = parseBatchText(`C:/clips/CLIP.MP4${BATCH_SEPARATOR}HOOK`)
    expect(lines[0]!.problems).toEqual([])
    expect(extensionOf(lines[0]!.path)).toBe('mp4')
  })

  it('reports a missing location', () => {
    const lines = parseBatchText(`${BATCH_SEPARATOR}ONLY A HOOK`)
    expect(lines[0]!.problems.map((p) => p.code)).toEqual(['missing-path'])
    expect(lines[0]!.hook).toBe('ONLY A HOOK')
  })

  it('reports a non-video extension, with the offending extension named', () => {
    const lines = parseBatchText(`C:\\clips\\notes.txt${BATCH_SEPARATOR}HOOK`)
    expect(lines[0]!.problems).toEqual([{ code: 'unsupported-extension', detail: '.txt' }])
  })

  it('reports a path with no extension at all', () => {
    const lines = parseBatchText(`C:\\clips\\noext${BATCH_SEPARATOR}HOOK`)
    expect(lines[0]!.problems).toEqual([{ code: 'unsupported-extension', detail: 'no extension' }])
  })

  it('flags a repeated file at the later line only, case-insensitively', () => {
    const text = [
      `C:\\clips\\a.mp4${BATCH_SEPARATOR}FIRST`,
      `C:\\clips\\b.mp4${BATCH_SEPARATOR}SECOND`,
      `c:\\CLIPS\\A.MP4${BATCH_SEPARATOR}DUPLICATE`
    ].join('\n')
    const lines = parseBatchText(text)
    expect(lines[0]!.problems).toEqual([])
    expect(lines[1]!.problems).toEqual([])
    expect(lines[2]!.problems).toEqual([{ code: 'duplicate-path', detail: 'line 1' }])
  })

  it('leaves the hook empty but flags nothing when the separator is missing', () => {
    const lines = parseBatchText('C:\\clips\\a.mp4')
    expect(lines[0]!.hasSeparator).toBe(false)
    expect(lines[0]!.hook).toBe('')
    expect(lines[0]!.problems).toEqual([])
    expect(lines[0]!.path).toBe('C:\\clips\\a.mp4')
  })

  it('returns an empty queue for empty or whitespace-only text', () => {
    expect(parseBatchText('')).toEqual([])
    expect(parseBatchText('\n\n   \n\t\n')).toEqual([])
  })

  it('trims the hook text but preserves inner spacing', () => {
    const lines = parseBatchText(`C:\\a.mp4${BATCH_SEPARATOR}   HOOK  TEXT   `)
    expect(lines[0]!.hook).toBe('HOOK  TEXT')
  })

  it('keeps the raw line for echoing back to the UI', () => {
    const raw = `C:\\a.mp4  ${BATCH_SEPARATOR}  HOOK`
    const lines = parseBatchText(raw)
    expect(lines[0]!.raw).toBe(raw)
  })
})

describe('batch path helpers', () => {
  it('normalizes quoted paths', () => {
    expect(normalizeBatchPath('"C:\\a b\\c.mp4"')).toBe('C:\\a b\\c.mp4')
    expect(normalizeBatchPath('  C:\\a.mp4  ')).toBe('C:\\a.mp4')
    expect(normalizeBatchPath('"C:\\a.mp4')).toBe('"C:\\a.mp4')
  })

  it('computes basename and stem on both separators', () => {
    expect(basenameOf('C:\\clips\\tupai.mp4')).toBe('tupai.mp4')
    expect(basenameOf('C:/clips/tupai.mp4')).toBe('tupai.mp4')
    expect(basenameOf('C:\\clips\\')).toBe('clips')
    expect(stemOf('C:\\clips\\tupai.mp4')).toBe('tupai')
    expect(stemOf('C:\\clips\\no.ext.here.mp4')).toBe('no.ext.here')
    expect(stemOf('C:\\clips\\noext')).toBe('noext')
  })

  it('recognizes the video extensions the importer accepts', () => {
    expect(isVideoPath('a.mp4')).toBe(true)
    expect(isVideoPath('a.MOV')).toBe(true)
    expect(isVideoPath('a.webm')).toBe(true)
    expect(isVideoPath('a.txt')).toBe(false)
    expect(isVideoPath('a')).toBe(false)
    expect(isVideoPath('.mp4')).toBe(false)
  })

  it('picks the first required input as the hook receiver', () => {
    expect(hookFieldKeyOf([{ key: 'title' }, { key: 'hook', required: true }])).toBe('hook')
    expect(hookFieldKeyOf([{ key: 'title' }])).toBe('title')
    expect(hookFieldKeyOf([])).toBe('hook')
  })
})
