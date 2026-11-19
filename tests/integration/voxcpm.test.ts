import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stopVoxWorker, synthesizeVoxSpeech } from '../../src/core/tts/voxcpm'
import { resolveFfmpegBinariesCached } from '../../src/core/ffmpeg/resolve-bin'
import { makeScratchDir, removeScratchDir } from '../helpers/env'

describe('local speech pipeline', () => {
  afterEach(() => stopVoxWorker())

  it('reuses the worker, keeps reference paths stable per voice, and encodes WAV as MP3', async () => {
    const dir = await makeScratchDir('vox-worker')
    try {
      const worker = path.join(dir, 'worker.cjs')
      const captured = path.join(dir, 'request.json')
      await writeFile(worker, `
        const fs = require('node:fs');
        const lines = require('node:readline').createInterface({ input: process.stdin });
        lines.on('line', line => {
          const request = JSON.parse(line);
          fs.appendFileSync(${JSON.stringify(captured)}, JSON.stringify({ ...request, pid: process.pid }) + '\\n');
          const samples = 2400;
          const wav = Buffer.alloc(44 + samples * 2);
          wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
          wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
          wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
          wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
          wav.writeUInt32LE(samples * 2, 40); fs.writeFileSync(request.output, wav);
          process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + '\\n');
        });`)
      const { ffmpegPath } = await resolveFfmpegBinariesCached()
      const outputPath = path.join(dir, 'narration.mp3')
      const result = await synthesizeVoxSpeech({ text: 'Malam itu, hujan turun.', voiceId: 'penjelajah', outputPath, ffmpegPath, workerPath: worker, pythonPath: process.execPath, referenceCacheDir: dir })
      await synthesizeVoxSpeech({ text: 'Hujan turun.', voiceId: 'penjelajah', outputPath: path.join(dir, 'two.mp3'), ffmpegPath, workerPath: worker, pythonPath: process.execPath, referenceCacheDir: dir })
      await synthesizeVoxSpeech({ text: 'Hujan turun.', voiceId: 'petir', outputPath: path.join(dir, 'three.mp3'), ffmpegPath, workerPath: worker, pythonPath: process.execPath, referenceCacheDir: dir })
      const requests = (await readFile(captured, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { text: string; prompt: string; seed: number; pid: number; reference: string })
      const [request, second, third] = requests
      expect(request).toBeDefined()
      expect(second?.pid).toBe(request?.pid)
      expect(third?.pid).toBe(request?.pid)
      expect(second?.reference).toBe(request?.reference)
      expect(second?.reference).not.toBe(third?.reference)
      expect(second?.reference).toMatch(/\.wav$/)
      expect(request?.text).toBe('Malam itu, hujan turun.')
      expect(request?.prompt).toContain('Indonesian')
      expect(request?.seed).toBe(101)
      expect(result.bytes).toBeGreaterThan(0)
      expect((await readFile(outputPath)).subarray(0, 3).toString()).toBe('ID3')
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('rejects an unknown voice before starting a worker', async () => {
    await expect(synthesizeVoxSpeech({ text: 'Halo', voiceId: 'rimba', outputPath: 'unused', ffmpegPath: 'unused', workerPath: 'unused' })).rejects.toThrow('Unknown voice')
  })

  it('strips delivery tags before the script reaches the worker', async () => {
    const dir = await makeScratchDir('vox-tags')
    try {
      const worker = path.join(dir, 'worker.cjs')
      const captured = path.join(dir, 'request.json')
      await writeFile(worker, `
        const fs = require('node:fs');
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          fs.appendFileSync(${JSON.stringify(captured)}, JSON.stringify({ text: request.text }) + '\\n');
          const samples = 2400;
          const wav = Buffer.alloc(44 + samples * 2);
          wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
          wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
          wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
          wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
          wav.writeUInt32LE(samples * 2, 40); fs.writeFileSync(request.output, wav);
          process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + '\\n');
        });`)
      const { ffmpegPath } = await resolveFfmpegBinariesCached()
      await synthesizeVoxSpeech({
        text: '[hook]Kalau kaca dikut. [twist]Dia di belakangmu.',
        voiceId: 'penjelajah',
        outputPath: path.join(dir, 'tagged.mp3'),
        ffmpegPath,
        workerPath: worker,
        pythonPath: process.execPath,
        referenceCacheDir: dir
      })
      const requests = (await readFile(captured, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { text: string })
      const sent = requests.map((r) => r.text).join(' ')
      expect(sent).not.toContain('[hook]')
      expect(sent).not.toContain('[twist]')
      expect(sent).toContain('Kalau kaca dikut.')
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('reports when a worker claims success without producing audio', async () => {
    const dir = await makeScratchDir('vox-missing-audio')
    try {
      const worker = path.join(dir, 'worker.cjs')
      await writeFile(worker, `
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, ok: true }) + '\\n')
        })`)
      await expect(synthesizeVoxSpeech({
        text: 'Halo.', voiceId: 'penjelajah', outputPath: path.join(dir, 'output.mp3'),
        ffmpegPath: 'unused', workerPath: worker, pythonPath: process.execPath
      })).rejects.toThrow('did not produce an audio file')
    } finally {
      await removeScratchDir(dir)
    }
  })

  it('cancels a running worker without leaving an output file', async () => {
    const dir = await makeScratchDir('vox-cancel')
    try {
      const worker = path.join(dir, 'wait.cjs')
      await writeFile(worker, 'setInterval(() => {}, 1000)')
      const outputPath = path.join(dir, 'cancelled.mp3')
      const controller = new AbortController()
      const result = synthesizeVoxSpeech({ text: 'Halo', voiceId: 'penjelajah', outputPath, ffmpegPath: 'unused', workerPath: worker, pythonPath: process.execPath, signal: controller.signal })
      setTimeout(() => controller.abort(), 150)
      await expect(result).rejects.toThrow('cancelled')
      await expect(readFile(outputPath)).rejects.toThrow()
    } finally {
      await removeScratchDir(dir)
    }
  })
})
