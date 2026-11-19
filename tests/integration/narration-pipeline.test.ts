import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runNarrationPipeline } from '../../src/core/tts/pipeline'
import { stopAsrWorker } from '../../src/core/tts/asr'
import { stopVoxWorker } from '../../src/core/tts/voxcpm'
import { resolveFfmpegBinariesCached } from '../../src/core/ffmpeg/resolve-bin'
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
      const voxWorker = path.join(dir, 'vox.cjs')
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
          fs.writeFileSync(request.output, wav);
          process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + '\\n');
        });`
      )

      // --- fake ASR worker: first two calls flunk (garbage + clipped onset),
      // everything after returns the sidecar text with clean timing at ~130wpm.
      const asrWorker = path.join(dir, 'asr.cjs')
      await writeFile(
        asrWorker,
        `
        const fs = require('node:fs');
        let calls = 0;
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          calls += 1;
          let response;
          try {
            if (calls <= 2) {
              response = { id: request.id, ok: true, transcript: 'er er er er er er',
                words: [{ word: 'er', start: 0.0, end: 0.4 }], durationSec: 1.5 };
            } else {
              const text = fs.readFileSync(request.wav + '.txt', 'utf8').trim();
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
        voxWorkerPath: voxWorker,
        asrWorkerPath: asrWorker,
        pythonPath: process.execPath,
        asrPythonPath: process.execPath,
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
        chunks: Array<{ retries: number; status: string; attempts: Array<{ seed: number; passed: boolean }> }>
        masterFilter: string
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
      expect(report.chunks[0]?.attempts.map((a) => a.seed)).toEqual([707, 808, 909])
      expect(report.chunks.slice(1).every((c) => c.retries === 0)).toBe(true)
      expect(report.passed).toBe(true)
      expect(report.failedChunks).toBe(0)
      expect(report.masterFilter).toContain('loudnorm=I=-14:TP=-1.0:LRA=7')

      // Timestamps: monotonic chunk timeline, words inside their chunks.
      for (let i = 1; i < timestamps.chunks.length; i += 1) {
        expect(timestamps.chunks[i]!.start).toBeGreaterThan(timestamps.chunks[i - 1]!.end)
      }
      expect(timestamps.words.length).toBeGreaterThan(0)
      const twistWords = timestamps.words.filter((w) => w.chunk === 2)
      expect(twistWords.length).toBeGreaterThan(0)
      expect(twistWords[0]!.start).toBeGreaterThanOrEqual(timestamps.chunks[2]!.start)
      // The pre-reveal beat: ≥500ms of silence before the twist chunk.
      const preTwistGap = timestamps.chunks[2]!.start - timestamps.chunks[1]!.end
      expect(preTwistGap).toBeGreaterThanOrEqual(0.5)

      // The vox worker saw tag-shaped prompts and distinct reference clips.
      const voxRequests = (await readFile(voxLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as {
        text: string; prompt: string; seed: number; reference: string
      })
      const hookReq = voxRequests.find((r) => r.text.startsWith('Kalau kaca'))!
      const tacticalReq = voxRequests.find((r) => r.text.startsWith('Pertama'))!
      const twistReq = voxRequests.find((r) => r.text.startsWith('Yang mengetuk'))!
      expect(hookReq.prompt).toContain('Urgent, firm')
      expect(tacticalReq.prompt).toContain('Calm, authoritative')
      expect(twistReq.prompt).toContain('Slower, darker')
      expect(new Set([hookReq.reference, tacticalReq.reference, twistReq.reference]).size).toBe(3)
      // Chunk texts reach the worker with tags already stripped.
      expect(voxRequests.every((r) => !r.text.includes('['))).toBe(true)

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
        voxWorkerPath: voxWorker,
        asrWorkerPath: asrWorker,
        pythonPath: process.execPath,
        asrPythonPath: process.execPath,
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
