/**
 * One-off live smoke check for local VoxCPM and MP3 encoding.
 * Run: pnpm exec tsx scripts/tts-smoke.ts [voiceId]
 */
import { execFileSync } from 'node:child_process'
import ffprobe from 'ffprobe-static'
import { resolveFfmpegBinariesCached } from '../src/core/ffmpeg/resolve-bin'
import path from 'node:path'
import { stopVoxWorker, synthesizeVoxSpeech } from '../src/core/tts/voxcpm'
import { findVoicePreset, VOICE_PRESETS } from '../src/shared/tts/voices'

const voiceId = process.argv[2] ?? 'penjelajah'
const preset = findVoicePreset(voiceId)
if (!preset) {
  console.error(`Unknown voice: ${voiceId}. Known: ${VOICE_PRESETS.map((v) => v.id).join(', ')}`)
  process.exit(1)
}

function probe(file: string): string {
  return execFileSync(ffprobe.path, [
    '-v', 'error',
    '-show_entries', 'format=duration,bit_rate',
    '-show_entries', 'stream=codec_name,sample_rate,channels',
    '-of', 'json',
    file
  ]).toString()
}

async function main(): Promise<void> {
  try {
    const { ffmpegPath } = await resolveFfmpegBinariesCached()
    const out = `${process.env.TEMP ?? '.'}\\shortz-tts-smoke-${preset.id}.mp3`
    const started = Date.now()
    const r = await synthesizeVoxSpeech({
      text: 'Hujan turun sepanjang malam. Air merendah pinggul. Aku bertahan.',
      voiceId: preset.id,
      outputPath: out,
      ffmpegPath,
      workerPath: path.resolve('resources/tts/voxcpm_worker.py')
    })
    console.log(`OK voice=${preset.id} bytes=${r.bytes} ms=${Date.now() - started} file=${r.path}`)
    console.log(probe(r.path).replace(/\s+/g, ' '))
  } catch (e) {
    console.error('FAIL:', e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  } finally {
    stopVoxWorker()
  }
}

void main()
