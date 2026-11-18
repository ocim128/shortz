/**
 * One-off live smoke check for the full TTS pipeline (network + ffmpeg
 * stitch — not part of the test suite). Run: pnpm exec tsx scripts/tts-smoke.ts [voiceId]
 */
import { execFileSync } from 'node:child_process'
import ffprobe from 'ffprobe-static'
import { resolveFfmpegBinariesCached } from '../src/core/ffmpeg/resolve-bin'
import { synthesizeSpeech } from '../src/core/tts/synthesize'
import { findVoicePreset, VOICE_PRESETS } from '../src/shared/tts/voices'

const voiceId = process.argv[2] ?? 'rimba'
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
    const r = await synthesizeSpeech({
      text: 'Hujan turun sepanjang malam. Air merendah pinggul. Aku bertahan.',
      voiceId: preset.id,
      outputPath: out,
      ffmpegPath
    })
    console.log(`OK voice=${preset.id} bytes=${r.bytes} ms=${Date.now() - started} file=${r.path}`)
    console.log(probe(r.path).replace(/\s+/g, ' '))
  } catch (e) {
    console.error('FAIL:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

void main()
