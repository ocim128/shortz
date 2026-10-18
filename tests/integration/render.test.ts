import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probeSource } from '../../src/core/ffmpeg/probe'
import { resolveFfmpegBinariesCached } from '../../src/core/ffmpeg/resolve-bin'
import { runFfmpeg } from '../../src/core/ffmpeg/runner'
import {
  renderProject,
  RenderCancelledError,
  type RenderRequest
} from '../../src/core/render/orchestrator'
import {
  createProjectDocument,
  loadProjectDocument,
  type ProjectDocument
} from '../../src/core/store/projects'
import type { Template } from '../../src/shared/template/types'
import {
  FIXTURES_DIR,
  fixture,
  GOLDEN_DIR,
  loadHookTemplate,
  makeScratchDir,
  REPO_ROOT,
  removeScratchDir
} from '../helpers/env'

let ffmpegPath = ''
let ffprobePath = ''
let scratchRoot = ''
let probeCacheDir = ''
let template: Template

beforeAll(async () => {
  const binaries = await resolveFfmpegBinariesCached({})
  ffmpegPath = binaries.ffmpegPath
  ffprobePath = binaries.ffprobePath
  scratchRoot = await makeScratchDir('render')
  probeCacheDir = path.join(scratchRoot, 'probe-cache')
  template = loadHookTemplate()
})

afterAll(async () => {
  if (scratchRoot) await removeScratchDir(scratchRoot)
})

function makeProject(
  sourceName: string,
  overrides: Partial<ProjectDocument> = {}
): ProjectDocument {
  const project = createProjectDocument({
    name: `test-${sourceName}`,
    sourcePath: fixture(sourceName),
    templateId: 'hook-letterbox',
    values: { fields: { hook: 'Hello from the render test' }, knobs: {} }
  })
  return { ...project, ...overrides }
}

function requestFor(
  project: ProjectDocument,
  outputName: string,
  overrides: Partial<RenderRequest> = {}
): RenderRequest {
  return {
    project,
    template,
    outputPath: path.join(scratchRoot, outputName),
    resourcesDir: path.join(REPO_ROOT, 'resources'),
    tmpRoot: path.join(scratchRoot, 'jobs'),
    probeCacheDir,
    ffmpegPath,
    ffprobePath,
    ...overrides
  }
}

function assertFaststart(filePath: string): void {
  const buffer = readFileSync(filePath)
  const moov = buffer.indexOf('moov')
  const mdat = buffer.indexOf('mdat')
  expect(moov).toBeGreaterThan(0)
  expect(mdat).toBeGreaterThan(0)
  expect(moov).toBeLessThan(mdat)
}

/** Decode-count the video stream (ffprobe -count_frames). */
function countFrames(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-select_streams', 'v:0', '-count_frames', '-show_streams', videoPath],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe -count_frames exited ${code}: ${stderr}`))
        return
      }
      const parsed = JSON.parse(stdout) as { streams?: Array<{ nb_read_frames?: string }> }
      const frames = Number(parsed.streams?.[0]?.nb_read_frames)
      if (!Number.isFinite(frames)) reject(new Error('nb_read_frames missing'))
      else resolve(frames)
    })
  })
}

describe('renderProject — acceptance matrix', () => {
  it('renders the sample project: trimmed, 1080x1920, AAC stereo, faststart', async () => {
    const loaded = await loadProjectDocument(fixture('sample-project.json'))
    const project: ProjectDocument = {
      ...loaded,
      source: { ...loaded.source, path: path.resolve(FIXTURES_DIR, loaded.source.path) }
    }
    const result = await renderProject(requestFor(project, 'sample.mp4'))

    expect(result.outputPath).toBe(path.join(scratchRoot, 'sample.mp4'))
    expect(result.width).toBe(1080)
    expect(result.height).toBe(1920)
    expect(result.fps).toBe(30)
    expect(result.audioCodec).toBe('aac')
    expect(result.audioChannels).toBe(2)
    expect(result.durationSec).toBeCloseTo(7, 1)
    expect(result.layout.video).toMatchObject({ x: 0, y: 520, w: 1080, h: 608 })
    // The shipped sample must render warning-free at default knobs (P2): the
    // hook fits the 338px above-video room without clamping. Clamp behaviour
    // itself stays covered by tests/unit/layout-engine.test.ts.
    expect(result.warnings).toEqual([])

    const out = await probeSource(ffprobePath, result.outputPath)
    expect(out.width).toBe(1080)
    expect(out.height).toBe(1920)
    expect(out.videoCodec).toBe('h264')
    expect(out.hasAudio).toBe(true)
    expect(out.audioChannels).toBe(2)
    expect(out.durationSec).toBeGreaterThan(6.5)
    expect(out.durationSec).toBeLessThan(7.6)
    assertFaststart(result.outputPath)
  })

  it('pillarboxes a rotation-normalized portrait clip', async () => {
    const result = await renderProject(
      requestFor(makeProject('portrait_rotated.mp4'), 'portrait.mp4')
    )
    expect(result.layout.video).toMatchObject({ x: 265, y: 520, w: 551, h: 980 })
    const out = await probeSource(ffprobePath, result.outputPath)
    expect(out.width).toBe(1080)
    expect(out.height).toBe(1920)
  })

  it('renders a silent 4:3 AVI without any audio stream', async () => {
    const result = await renderProject(requestFor(makeProject('square_4x3.avi'), 'silent.mp4'))
    expect(result.audioCodec).toBeNull()
    expect(result.layout.video).toMatchObject({ w: 1080, h: 810 })
    const out = await probeSource(ffprobePath, result.outputPath)
    expect(out.hasAudio).toBe(false)
  })

  it('downmixes 5.1 audio to stereo', async () => {
    const result = await renderProject(requestFor(makeProject('surround_5_1.mp4'), 'surround.mp4'))
    const out = await probeSource(ffprobePath, result.outputPath)
    expect(out.hasAudio).toBe(true)
    expect(out.audioChannels).toBe(2)
  })

  it('honors audio: "mute"', async () => {
    const result = await renderProject(
      requestFor(makeProject('landscape_1080p_10s.mp4', { audio: 'mute' }), 'muted.mp4')
    )
    expect(result.audioCodec).toBeNull()
    const out = await probeSource(ffprobePath, result.outputPath)
    expect(out.hasAudio).toBe(false)
  })

  it('renders the blur background with rounded corners', async () => {
    const project = makeProject('landscape_1080p_10s.mp4') as ProjectDocument
    project.values.knobs = { backgroundStyle: 'blurVideo' }
    const result = await renderProject(requestFor(project, 'blur.mp4'))
    expect(result.layout.canvas.background).toBe('blurVideo')
    const out = await probeSource(ffprobePath, result.outputPath)
    expect(out.width).toBe(1080)
    expect(out.height).toBe(1920)
  })

  it('forces VFR sources to 30fps CFR', async () => {
    const result = await renderProject(requestFor(makeProject('landscape_vfr.mp4'), 'vfr.mp4'))
    const out = await probeSource(ffprobePath, result.outputPath)
    expect(out.fpsRational).toMatch(/^30(\/1)?$/)
  })

  it('suffixes rather than overwrites an existing output', async () => {
    const first = await renderProject(requestFor(makeProject('tiny_2s.mp4'), 'dupe.mp4'))
    const second = await renderProject(requestFor(makeProject('tiny_2s.mp4'), 'dupe.mp4'))
    expect(existsSync(first.outputPath)).toBe(true)
    expect(second.outputPath).not.toBe(first.outputPath)
    expect(second.outputPath).toMatch(/_1\.mp4$/)
  })

  it('cancels mid-render and sweeps the job directory', async () => {
    const controller = new AbortController()
    const jobId = 'test-cancel-job'
    const project = makeProject('landscape_1080p_10s.mp4')
    await expect(
      renderProject(
        requestFor(project, 'cancelled.mp4', {
          jobId,
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.stage === 'render' && progress.pct > 5) controller.abort()
          }
        })
      )
    ).rejects.toBeInstanceOf(RenderCancelledError)
    expect(existsSync(path.join(scratchRoot, 'jobs', jobId))).toBe(false)
    expect(existsSync(path.join(scratchRoot, 'cancelled.mp4'))).toBe(false)
  })

  it('keeps CFR frame count and duration with the decode-once overlay input', async () => {
    // The overlay PNG is fed at -framerate 1 (one decode, repeated by the
    // overlay filter). Regression guard: the output must still be 30fps CFR
    // spanning the full clip — frames == duration x fps.
    const result = await renderProject(requestFor(makeProject('landscape_1080p_10s.mp4'), 'frames.mp4'))
    const out = await probeSource(ffprobePath, result.outputPath)
    expect(out.durationSec).toBeGreaterThan(9)
    expect(out.durationSec).toBeLessThan(11)
    const frames = await countFrames(result.outputPath)
    expect(Math.abs(frames - out.durationSec * 30)).toBeLessThanOrEqual(1)
  })
})

describe('golden frame', () => {
  async function extractFrame(videoPath: string, atSec: number, outPath: string): Promise<void> {
    const run = await runFfmpeg({
      ffmpegPath,
      args: ['-y', '-ss', String(atSec), '-i', videoPath, '-frames:v', '1', outPath],
      durationSec: 0.5
    })
    expect(run.code).toBe(0)
  }

  it('matches the committed hook-letterbox reference frame', async () => {
    const loaded = await loadProjectDocument(fixture('sample-project.json'))
    const project: ProjectDocument = {
      ...loaded,
      source: { ...loaded.source, path: path.resolve(FIXTURES_DIR, loaded.source.path) }
    }
    const result = await renderProject(requestFor(project, 'golden-sample.mp4'))

    const framePath = path.join(scratchRoot, 'golden-frame.png')
    await extractFrame(result.outputPath, 2, framePath)

    const referencePath = path.join(GOLDEN_DIR, 'hook-letterbox-2s.png')
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(referencePath)) {
      await mkdir(GOLDEN_DIR, { recursive: true })
      await writeFile(referencePath, await readFile(framePath))
      console.warn(`[golden] reference written: ${referencePath} (re-run without UPDATE_GOLDEN)`)
      return
    }

    const reference = PNG.sync.read(await readFile(referencePath))
    const actual = PNG.sync.read(await readFile(framePath))
    expect(actual.width).toBe(reference.width)
    expect(actual.height).toBe(reference.height)
    const diff = new PNG({ width: actual.width, height: actual.height })
    const mismatched = pixelmatch(
      reference.data,
      actual.data,
      diff.data,
      actual.width,
      actual.height,
      { threshold: 0.1 }
    )
    const ratio = mismatched / (actual.width * actual.height)
    expect(ratio).toBeLessThan(0.02)
  })
})
