import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runNarrationPipeline } from '../../src/core/tts/pipeline'
import { createVoxProvider, type TtsProvider, type TtsProviderChunkRequest, type TtsProviderContext } from '../../src/core/tts/provider'
import { createGeminiTtsProvider } from '../../src/core/tts/gemini-tts'
import { stopAsrWorker } from '../../src/core/tts/asr'
import { stopVoxWorker } from '../../src/core/tts/voxcpm'
import { resolveFfmpegBinariesCached } from '../../src/core/ffmpeg/resolve-bin'
import { conditionedWavDuration, measureAudioMetrics } from '../../src/core/tts/postprocess'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

/**
 * Full pipeline against fake workers (vox synth + ASR, both plain Node
 * scripts speaking the JSON-lines protocol) with REAL ffmpeg conditioning,
 * stitching and mastering — the hermetic pattern from voxcpm.test.ts.
 */

const SCRIPT = [
  '[hook]Kalau kaca mobil dikut, jangan buka.',
  '[tactical]Pertama, kunci pintu. Kedua, matikan lampu.',
  '[twist]Yang mengetuk duduk di belakangmu.'
].join('\n\n')

function silentWav(seconds: number, sampleRate = 16000): Buffer {
  const samples = Math.max(1, Math.round(seconds * sampleRate))
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  return wav
}

describe('narration pipeline', () => {
  afterEach(() => {
    stopAsrWorker()
    stopVoxWorker()
  })

  it('verifies, retries, paces by tag, and produces the three artifacts', async () => {
    const dir = await makeScratchDir('narration-pipeline')
    try {
      const { ffmpegPath, ffprobePath } = await resolveFfmpegBinariesCached()

      // --- fake vox worker: writes a real WAV sized to the text, records
      // every request, and drops the text next to the file for the ASR fake.
      const voxWorker = path.join(dir, 'voxcpm_worker.py')
      const voxLog = path.join(dir, 'vox-log.jsonl')
      await writeFile(
        voxWorker,
        `
        const fs = require('node:fs');
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          fs.appendFileSync(${JSON.stringify(voxLog)}, JSON.stringify(request) + '\\n');
          fs.writeFileSync(request.output + '.txt', request.text);
          const words = request.text.split(/\\s+/).filter(Boolean).length;
          const samples = Math.max(Math.round(0.46 * words * 16000) + 4800, 12800);
          const wav = Buffer.alloc(44 + samples * 2);
          wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
          wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
          wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
          wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
          wav.writeUInt32LE(samples * 2, 40);
          // A square wave (NOT silence): loudnorm must have real energy to
          // pull to the -14 LUFS target, and afftdn needs a noise-like floor.
          for (let i = 0; i < samples; i++) {
            wav.writeInt16LE(i % 2 ? -4000 : 4000, 44 + i * 2);
          }
          fs.writeFileSync(request.output, wav);
          process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + '\\n');
        });`
      )

      // --- fake ASR worker: first two calls flunk (garbage + clipped onset),
      // everything after returns the sidecar text with clean timing at ~130wpm.
      const asrWorker = path.join(dir, 'asr.cjs')
      const asrLog = path.join(dir, 'asr-log.jsonl')
      await writeFile(
        asrWorker,
        `
        const fs = require('node:fs');
        let calls = 0;
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          calls += 1;
          fs.appendFileSync(${JSON.stringify(asrLog)}, JSON.stringify(request) + '\\n');
          let response;
          try {
            if (calls <= 4) {
              response = { id: request.id, ok: true, transcript: 'er er er er er er',
                words: [{ word: 'er', start: 0.0, end: 0.4 }], durationSec: 1.5 };
            } else {
              const text = fs.readFileSync(request.wav.replace(/p(\\d+)-a/, 'c$1-a') + '.txt', 'utf8').trim();
              const tokens = text.split(/\\s+/).filter(Boolean);
              const per = 0.46;
              const words = tokens.map((word, i) => ({
                word, start: 0.05 + i * per, end: 0.05 + i * per + per * 0.9
              }));
              const durationSec = 0.05 + tokens.length * per + 0.2;
              response = { id: request.id, ok: true, transcript: text, words, durationSec };
            }
          } catch (error) {
            response = { id: request.id, ok: false, error: String(error) };
          }
          process.stdout.write(JSON.stringify(response) + '\\n');
        });`
      )

      const output = path.join(dir, 'narration.mp3')
      const result = await runNarrationPipeline({
        script: SCRIPT,
        voiceId: 'jejak',
        outputMp3: output,
        ffmpegPath,
        asrWorkerPath: asrWorker,
        asrModel: 'small',
        asrPythonPath: process.execPath,
        pythonPath: process.execPath,
        referenceCacheDir: path.join(dir, 'refs'),
        master: true
      })

      // --- the three artifacts exist and are self-consistent ------------------
      // (staged inside the pipeline's scratch dir; publishing is the CLI's job)
      const mp3 = await readFile(result.mp3)
      expect(mp3.subarray(0, 3).toString('ascii')).toBe('ID3')
      const timestamps = JSON.parse(await readFile(result.timestamps, 'utf8')) as {
        durationSec: number
        chunks: Array<{ tag: string | null; text: string; start: number; end: number; retries: number; status: string }>
        words: Array<{ word: string; start: number; end: number; chunk: number }>
      }
      const report = JSON.parse(await readFile(result.report, 'utf8')) as {
        passed: boolean
        totalChunks: number
        failedChunks: number
        warningChunks: number
        provider: string
        asrModel: string
        audioQuality: { integratedLufs: number; loudnessRangeLu: number; noiseFloorDbfs: number | null; targets: { integratedLufs: number; loudnessRangeLu: number[] } }
        masterFilter: string
        chunks: Array<{ retries: number; status: string; attempts: Array<{ seed: number; passed: boolean }> }>
      }

      // 3 chunks: hook / tactical / twist.
      expect(timestamps.chunks.map((c) => c.tag)).toEqual(['hook', 'tactical', 'twist'])
      expect(timestamps.chunks.map((c) => c.text)).toEqual([
        'Kalau kaca mobil dikut, jangan buka.',
        'Pertama, kunci pintu. Kedua, matikan lampu.',
        'Yang mengetuk duduk di belakangmu.'
      ])
      // Chunk 1 flunked twice (garbage ASR), verified on the third take.
      expect(report.chunks[0]?.retries).toBe(2)
      expect(report.chunks[0]?.attempts.map((a) => a.passed)).toEqual([false, false, true])
      expect(report.chunks[0]?.attempts.map((a) => a.seed)).toEqual([0, 1, 2])
      expect(report.chunks.slice(1).every((c) => c.retries === 0)).toBe(true)
      expect(report.passed).toBe(true)
      expect(report.failedChunks).toBe(0)
      expect(report.provider).toBe('voxcpm')
      expect(report.asrModel).toBe('small')
      // Peak-only compressor + limiter own the loudness ceiling; loudnorm's
      // dynamic mode is banned (it flattened narration to LRA 2.6 live).
      expect(report.masterFilter).toContain('acompressor=threshold=-4dB:ratio=2.2:attack=10:release=80')
      expect(report.masterFilter).toContain('alimiter=limit=0.851')
      expect(report.masterFilter).not.toContain('loudnorm')

      // Measured audio quality: real loudnorm lands on the TikTok target.
      // (LRA is just "measured, present" here — constant synthetic tone has
      // no dynamics by construction; the live episode asserts the 5–7 band.)
      expect(report.audioQuality.integratedLufs).toBeGreaterThan(-16)
      expect(report.audioQuality.integratedLufs).toBeLessThan(-12)
      expect(report.audioQuality.loudnessRangeLu).toBeGreaterThanOrEqual(0)
      expect(report.audioQuality.targets).toEqual({ integratedLufs: -14, loudnessRangeLu: [5, 7] })

      // The vox worker saw ONE reference and ONE prompt for every chunk and
      // retry — speaker identity and accent cannot drift between chunks.
      const voxRequests = (await readFile(voxLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as {
        text: string; prompt: string; seed: number; reference: string; ffmpeg_path: string
      })
      expect(new Set(voxRequests.map((r) => r.reference)).size).toBe(1)
      expect(new Set(voxRequests.map((r) => r.prompt)).size).toBe(1)
      expect(voxRequests.every((r) => !r.text.includes('['))).toBe(true)
      expect(voxRequests.every((r) => typeof r.ffmpeg_path === 'string' && r.ffmpeg_path.length > 0)).toBe(true)
      // Retry seeds shift subtly from the fixed voice seed (707 for jejak).
      expect(voxRequests.map((r) => r.seed)).toEqual([707, 808, 909, 707, 707])

      // The verifier was asked for the small model.
      const asrRequests = (await readFile(asrLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { model: string })
      expect(asrRequests.every((r) => r.model === 'small')).toBe(true)

      // Timestamps: monotonic chunk timeline, words inside their chunks.
      for (let i = 1; i < timestamps.chunks.length; i += 1) {
        expect(timestamps.chunks[i]!.start).toBeGreaterThan(timestamps.chunks[i - 1]!.end)
      }
      expect(timestamps.words.length).toBeGreaterThan(0)
      const twistWords = timestamps.words.filter((w) => w.chunk === 2)
      expect(twistWords.length).toBeGreaterThan(0)
      expect(twistWords[0]!.start).toBeGreaterThanOrEqual(timestamps.chunks[2]!.start)
      // Deliberate rhythm: 450ms pre-twist beat; tight hook→tactical transition.
      const preTwistGap = timestamps.chunks[2]!.start - timestamps.chunks[1]!.end
      expect(preTwistGap).toBeGreaterThanOrEqual(0.44)
      const firstGap = timestamps.chunks[1]!.start - timestamps.chunks[0]!.end
      expect(firstGap).toBeGreaterThanOrEqual(0.25)
      expect(firstGap).toBeLessThanOrEqual(0.3)

      // The mastered MP3 matches the planned stitched duration closely.
      const probed = execFileSync(ffprobePath, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', result.mp3
      ]).toString()
      const mp3Duration = Number.parseFloat(probed.trim())
      expect(Math.abs(mp3Duration - timestamps.durationSec)).toBeLessThan(0.25)
      await result.cleanup()
    } finally {
      await removeScratchDir(dir)
    }
  }, 120_000)

  it.each([
    { id: 'stub', voiceId: 'jejak' },
    { id: 'edge', voiceId: 'rimba' }
  ])('runs with the $id provider and its voice', async ({ id, voiceId }) => {
    const dir = await makeScratchDir('narration-provider')
    try {
      const { ffmpegPath } = await resolveFfmpegBinariesCached()
      const asrWorker = path.join(dir, 'asr.cjs')
      await writeFile(
        asrWorker,
        `
        const fs = require('node:fs');
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          const text = fs.readFileSync(request.wav.replace(/p(\\d+)-a/, 'c$1-a') + '.txt', 'utf8').trim();
          const tokens = text.split(/\\s+/).filter(Boolean);
          const per = 0.46;
          const words = tokens.map((word, i) => ({ word, start: 0.1 + i * per, end: 0.1 + i * per + per * 0.9 }));
          process.stdout.write(JSON.stringify({
            id: request.id, ok: true, transcript: text, words,
            durationSec: 0.1 + tokens.length * per + 0.2
          }) + '\\n');
        });`
      )

      // A drop-in alternative engine: writes the chunk, records what it got.
      const seen: Array<{ text: string; attempt: number; chunkIndex: number }> = []
      const stub: TtsProvider = {
        id,
        async synthesizeChunk(request: TtsProviderChunkRequest, _context: TtsProviderContext) {
          seen.push({ text: request.text, attempt: request.attempt, chunkIndex: request.chunkIndex })
          const sidecar = `${request.outputWav}.txt`
          await writeFile(sidecar, request.text)
          await writeFile(request.outputWav, silentWav(Math.max(1, request.text.split(/\s+/).length * 0.46)))
        },
        stop() { /* nothing to release */ }
      }

      const output = path.join(dir, 'narration.mp3')
      const result = await runNarrationPipeline({
        // Paragraph break forces two chunks — proves per-chunk provider calls.
        script: '[hook]Hujan turun. [sfx:knock] [twist]Kami bertahan.',
        voiceId,
        outputMp3: output,
        ffmpegPath,
        provider: stub,
        asrWorkerPath: asrWorker,
        asrPythonPath: process.execPath,
        master: false
      })
      expect(seen.length).toBe(2)
      expect(seen[0]?.chunkIndex).toBe(0)
      expect(seen[1]?.chunkIndex).toBe(1)
      // Read the staged artifacts BEFORE cleanup — cleanup removes the scratch dir.
      const report = JSON.parse(await readFile(result.report, 'utf8')) as { provider: string; passed: boolean }
      expect(report.provider).toBe(id)
      // Word timings exist for the stub provider too — captions stay provider-agnostic.
      const timestamps = JSON.parse(await readFile(result.timestamps, 'utf8')) as { words: unknown[]; sfx: Array<{ name: string; time: number }> }
      expect(timestamps.words.length).toBeGreaterThan(0)
      expect(timestamps.sfx).toHaveLength(1)
      expect(timestamps.sfx[0]?.name).toBe('knock')
      expect(seen.every((item) => !item.text.includes('sfx'))).toBe(true)
      const timing = JSON.parse(await readFile(result.timestamps, 'utf8')) as { chunks: Array<{ start: number; end: number }> }
      expect(timestamps.sfx[0]!.time).toBeCloseTo(timing.chunks[1]!.start, 3)
      const actualFirstDuration = await conditionedWavDuration(path.join(path.dirname(result.mp3), 'p0-a0.wav'))
      expect(timing.chunks[0]!.end - timing.chunks[0]!.start).toBeCloseTo(actualFirstDuration, 3)
      await result.cleanup()
    } finally {
      await removeScratchDir(dir)
    }
  }, 60_000)

  it('measures separate audio windows and respects cancellation', async () => {
    const dir = await makeScratchDir('narration-metrics')
    try {
      const { ffmpegPath } = await resolveFfmpegBinariesCached()
      const wav = silentWav(12, 48000)
      for (let i = 0; i < 12 * 48000; i++) {
        const amplitude = i < 4 * 48000 ? 10000 : i < 8 * 48000 ? 100 : 0
        wav.writeInt16LE(i % 2 ? amplitude : -amplitude, 44 + i * 2)
      }
      const file = path.join(dir, 'levels.wav')
      await writeFile(file, wav)
      const metrics = await measureAudioMetrics(ffmpegPath, file)
      expect(metrics.noiseFloorDbfs).toBeCloseTo(-50.3, 0)
      const controller = new AbortController()
      controller.abort()
      await expect(measureAudioMetrics(ffmpegPath, file, controller.signal)).rejects.toThrow('cancelled')
    } finally {
      await removeScratchDir(dir)
    }
  }, 60_000)

  it('retries and fails when conditioning causes a word to be cut off', async () => {
    const dir = await makeScratchDir('narration-conditioned-verify')
    try {
      const { ffmpegPath } = await resolveFfmpegBinariesCached()
      const asrWorker = path.join(dir, 'asr.cjs')
      await writeFile(asrWorker, `
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const r = JSON.parse(line);
          const conditioned = require('node:path').basename(r.wav).startsWith('p');
          const text = conditioned ? 'Hujan turu' : 'Hujan turun';
          const words = text.split(' ').map((word, i) => ({word, start: 0.1 + i * 0.4, end: 0.4 + i * 0.4}));
          process.stdout.write(JSON.stringify({id: r.id, ok: true, transcript: text, words, durationSec: 1.0}) + '\\n');
        });`)
      let calls = 0
      const provider: TtsProvider = { id: 'stub', stop() {}, async synthesizeChunk(request) {
        calls++
        await writeFile(request.outputWav, silentWav(1))
      } }
      const result = await runNarrationPipeline({ script: 'Hujan turun.', voiceId: 'jejak',
        outputMp3: path.join(dir, 'out.mp3'), ffmpegPath, provider,
        asrWorkerPath: asrWorker, asrPythonPath: process.execPath, master: false })
      try {
        const report = JSON.parse(await readFile(result.report, 'utf8')) as {
          passed: boolean; chunks: Array<{ status: string; attempts: Array<{ mismatches: unknown[]; rawMismatches: unknown[] }> }>
        }
        expect(calls).toBe(3)
        expect(report.passed).toBe(false)
        expect(report.chunks[0]!.status).toBe('failed')
        expect(report.chunks[0]!.attempts[0]!.rawMismatches).toEqual([])
        expect(report.chunks[0]!.attempts[0]!.mismatches).toContainEqual({ expected: 'turun', heard: 'turu' })
      } finally { await result.cleanup() }
    } finally { await removeScratchDir(dir) }
  }, 60_000)

  it.each([
    ['gemini-tts', false], ['gemini-tts', true], ['gemini-cloud', false], ['gemini-cloud', true]
  ] as const)('aligns the finished %s MP3 and reports final mismatch=%s', async (providerId, finalMismatch) => {
    const dir = await makeScratchDir('narration-gemini')
    try {
      const { ffmpegPath } = await resolveFfmpegBinariesCached()
      const asrWorker = path.join(dir, 'asr.cjs')
      await writeFile(asrWorker, `
        const path = require('node:path');
        require('node:readline').createInterface({input: process.stdin}).on('line', line => {
          const r = JSON.parse(line), base = path.basename(r.wav);
          const final = base.endsWith('.mp3');
          const text = final ? ${JSON.stringify(finalMismatch ? 'Hujan turun. Kami pergi.' : 'Hujan turun. Kami bertahan.')} : base.includes('1-a') ? 'Kami bertahan.' : 'Hujan turun.';
          const words = text.split(/\\s+/).map((word, i) => ({ word, start: 0.1 + i * 0.4, end: 0.4 + i * 0.4 }));
          process.stdout.write(JSON.stringify({id: r.id, ok: true, transcript: text, words, durationSec: final ? 2 : 1}) + '\\n');
        });`)
      const seen: TtsProviderChunkRequest[] = []
      const provider: TtsProvider = { id: providerId, model: 'gemini-3.8-flash-tts', stop() {},
        async synthesizeChunk(request) { seen.push(request); await writeFile(request.outputWav, silentWav(1)) } }
      const result = await runNarrationPipeline({ script: '[hook]Hujan turun. [twist]Kami bertahan.', voiceId: 'Charon',
        outputMp3: path.join(dir, 'out.mp3'), ffmpegPath, provider,
        asrWorkerPath: asrWorker, asrPythonPath: process.execPath, master: true })
      try {
        const report = JSON.parse(await readFile(result.report, 'utf8')) as {
          masterFilter: string; finalAlignment: { transcript: string; passed: boolean }
        }
        const timestamps = JSON.parse(await readFile(result.timestamps, 'utf8')) as { words: Array<{ word: string; start: number }> }
        expect(seen.map((request) => request.tag)).toEqual(['hook', 'twist'])
        expect(report.masterFilter).toContain('loudnorm=I=-14:LRA=6')
        expect(report.masterFilter).not.toContain('afftdn')
        expect(report.finalAlignment.passed).toBe(!finalMismatch)
        expect(result.passed).toBe(!finalMismatch)
        expect(timestamps.words.map((word) => word.word)).toEqual(['Hujan', 'turun.', 'Kami', finalMismatch ? 'pergi.' : 'bertahan.'])
        expect(timestamps.words[2]!.start).toBe(0.9)
      } finally { await result.cleanup() }
    } finally { await removeScratchDir(dir) }
  }, 60_000)

  it('resumes saved Gemini chunks after quota exhaustion and clears the cache on publication', async () => {
    const dir = await makeScratchDir('gemini-resume')
    try {
      const { ffmpegPath } = await resolveFfmpegBinariesCached()
      const asrWorker = path.join(dir, 'asr.cjs')
      await writeFile(asrWorker, `
        const path = require('node:path');
        require('node:readline').createInterface({input: process.stdin}).on('line', line => {
          const r = JSON.parse(line), base = path.basename(r.wav);
          const final = base.endsWith('.mp3');
          const text = final ? 'Hujan turun. Kami bertahan.' : base.includes('1-a') ? 'Kami bertahan.' : 'Hujan turun.';
          const words = text.split(/\\s+/).map((word, i) => ({ word, start: 0.1 + i * 0.4, end: 0.4 + i * 0.4 }));
          process.stdout.write(JSON.stringify({id: r.id, ok: true, transcript: text, words, durationSec: final ? 2 : 1}) + '\\n');
        });`)
      const success = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: {
        mimeType: 'audio/wav', data: silentWav(1).toString('base64')
      } }] } }] }), { status: 200 })
      const firstFetch = vi.fn().mockImplementationOnce(async () => success())
        .mockImplementation(async () => new Response('', { status: 429, headers: { 'retry-after': '3600' } }))
      const secondFetch = vi.fn(async () => success())
      const options = { script: '[hook]Hujan turun. [twist]Kami bertahan.', voiceId: 'Charon',
        outputMp3: path.join(dir, 'out.mp3'), ffmpegPath, asrWorkerPath: asrWorker,
        asrPythonPath: process.execPath, master: false }
      await expect(runNarrationPipeline({ ...options,
        provider: createGeminiTtsProvider({ apiKey: 'fake', fetchImpl: firstFetch as typeof fetch }) }))
        .rejects.toThrow('rate limit')
      const cacheRoot = path.join(dir, '.shortz-tts-cache')
      expect(await readdir(cacheRoot)).toHaveLength(1)
      const resumed: number[] = []
      const result = await runNarrationPipeline({ ...options,
        provider: createGeminiTtsProvider({ apiKey: 'fake', fetchImpl: secondFetch as typeof fetch }),
        onProgress: (info) => { if (info.phase === 'resuming' && info.chunk) resumed.push(info.chunk) } })
      expect(secondFetch).toHaveBeenCalledTimes(1)
      expect(resumed).toEqual([1])
      await result.cleanup()
      expect(await readdir(cacheRoot)).toEqual([])
    } finally { await removeScratchDir(dir) }
  }, 60_000)

  it('marks the report failed (not crashed) when every retry flunks a chunk', async () => {
    const dir = await makeScratchDir('narration-fail')
    try {
      const { ffmpegPath } = await resolveFfmpegBinariesCached()
      const voxWorker = path.join(dir, 'vox.cjs')
      await writeFile(
        voxWorker,
        `
        const fs = require('node:fs');
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          fs.writeFileSync(request.output + '.txt', request.text);
          const samples = 16000;
          const wav = Buffer.alloc(44 + samples * 2);
          wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
          wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
          wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
          wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
          wav.writeUInt32LE(samples * 2, 40);
          fs.writeFileSync(request.output, wav);
          process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + '\\n');
        });`
      )
      const asrWorker = path.join(dir, 'asr.cjs')
      await writeFile(
        asrWorker,
        `
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          process.stdout.write(JSON.stringify({
            id: request.id, ok: true, transcript: 'er er er er er er',
            words: [{ word: 'er', start: 0.5, end: 0.9 }], durationSec: 2.0
          }) + '\\n');
        });`
      )
      const output = path.join(dir, 'narration.mp3')
      const result = await runNarrationPipeline({
        script: 'Kamu meraih gagang pintu.',
        voiceId: 'jejak',
        outputMp3: output,
        ffmpegPath,
        provider: createVoxProvider({ workerPath: voxWorker }),
        asrWorkerPath: asrWorker,
        asrPythonPath: process.execPath,
        pythonPath: process.execPath,
        master: false
      })
      expect(result.passed).toBe(false)
      const report = JSON.parse(await readFile(result.report, 'utf8')) as {
        passed: boolean
        failedChunks: number
        chunks: Array<{ retries: number; status: string; attempts: Array<{ passed: boolean }> }>
      }
      expect(report.passed).toBe(false)
      expect(report.failedChunks).toBe(1)
      expect(report.chunks[0]?.status).toBe('failed')
      expect(report.chunks[0]?.retries).toBe(2) // 3 attempts, all kept in the report
      expect(report.chunks[0]?.attempts.every((a) => !a.passed)).toBe(true)
      // The audio still ships for inspection.
      expect((await readFile(result.mp3)).length).toBeGreaterThan(0)
      await result.cleanup()
    } finally {
      await removeScratchDir(dir)
    }
  }, 60_000)
})
