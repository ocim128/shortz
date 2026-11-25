import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { resolveFfmpegBinariesCached } from '../core/ffmpeg/resolve-bin'
import { stripBom } from '../core/store/fs-utils'
import { loadSettings, resolveDataDir } from '../core/store/settings'
import { stopAsrWorker } from '../core/tts/asr'
import { createProvider, PROVIDER_IDS } from '../core/tts/provider'
import { runNarrationPipeline, type NarrationArtifacts } from '../core/tts/pipeline'
import { publishNarrationArtifacts } from '../core/tts/publish'
import { DEFAULT_VOICE_ID, findVoicePreset, TTS_MAX_TEXT_LENGTH, VOICE_PRESETS } from '../shared/tts/voices'
import { DEFAULT_VOICE_ID as EDGE_DEFAULT_VOICE_ID, findVoicePreset as findEdgeVoicePreset, VOICE_PRESETS as EDGE_VOICE_PRESETS } from '../shared/tts/legacy-edge-voices'
import { DEFAULT_GEMINI_TTS_VOICE, GEMINI_TTS_VOICES, isGeminiCustomVoice } from '../core/tts/gemini-tts'
import { resolveGoogleCloudProject, resolveTtsEnvironment } from '../core/tts/environment'
import { ARCHIPELAGO_VOICE, ARCHIPELAGO_VOICE_ALIAS, ARCHIPELAGO_VOICE_ID, INVESTIGATOR_VOICE, INVESTIGATOR_VOICE_ID } from '../shared/tts/gemini'
export { resolveTtsEnvironment } from '../core/tts/environment'

const USAGE = `Usage:
  shortz tts (--text <text> | --text-file <utf8-file>) --output <narration.mp3> [--voice <id>]
  shortz tts --list-voices

The verified narration pipeline. Delivery tags [hook] [tactical] [twist] may be
embedded in the script; each tag shapes pacing/gaps/level until the next tag.
Writes next to the MP3:
  <stem>-timestamps.json  chunk + word timings on the stitched audio
  <stem>-report.json      per-chunk QA (ASR verification, retries, failures,
                          measured LUFS / LRA / noise floor)

Options:
  -o, --output <file>   MP3 path. Refuses an existing destination.
      --voice <id>     Voice preset (default: ${DEFAULT_VOICE_ID} for voxcpm, ${EDGE_DEFAULT_VOICE_ID} for edge)
      --text-file      Read the script from a UTF-8 file
      --text           Supply the script directly
      --no-master      Skip the broadcast mastering chain (default: on)
      --provider <id>  Speech engine: ${PROVIDER_IDS.join(' | ')} (default: gemini-cloud)
      --model <id>     Gemini TTS model (default: gemini-3.8-flash-tts)
      --gemini-key-index <n>  Use a specific configured Gemini key (1-based)
      --asr-model <s>  Whisper verifier size (default: small)
      --list-voices    Show available voice IDs
  -h, --help          Show this help

Exit codes: 0 pass · 1 usage/runtime error · 2 narration failed QA (see report)
`

export async function runTtsCommand(args: string[]): Promise<number> {
  try {
    const { providerDefault, geminiApiKeys } = await resolveTtsEnvironment()
    const { values } = parseArgs({
      args,
      options: {
        text: { type: 'string' },
        'text-file': { type: 'string' },
        output: { type: 'string', short: 'o' },
        voice: { type: 'string' },
        'no-master': { type: 'boolean' },
        provider: { type: 'string', default: providerDefault },
        model: { type: 'string' },
        'gemini-key-index': { type: 'string' },
        'asr-model': { type: 'string', default: 'small' },
        'list-voices': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
      }
    })
    if (values.help || args.length === 0) {
      process.stdout.write(USAGE)
      return 0
    }
    if (values['list-voices']) {
      if (!PROVIDER_IDS.includes(values.provider as (typeof PROVIDER_IDS)[number])) {
        throw new Error(`Unknown speech provider: ${values.provider}. Known: ${PROVIDER_IDS.join(', ')}`)
      }
      if (values.provider === 'cloud') {
        console.log('Cloud voice is selected by ELEVENLABS_VOICE_ID.')
        return 0
      }
      if (values.provider === 'gemini-tts' || values.provider === 'gemini-cloud') {
        const id = values.provider === 'gemini-cloud' ? INVESTIGATOR_VOICE.id : DEFAULT_GEMINI_TTS_VOICE
        console.log(`${id}\t${INVESTIGATOR_VOICE.name}\t${INVESTIGATOR_VOICE.description}`)
        if (values.provider === 'gemini-cloud') console.log(`${ARCHIPELAGO_VOICE_ALIAS}\t${ARCHIPELAGO_VOICE.name}\t${ARCHIPELAGO_VOICE.description} (${ARCHIPELAGO_VOICE_ID})`)
        for (const voice of GEMINI_TTS_VOICES) console.log(voice)
        return 0
      }
      for (const voice of values.provider === 'edge' ? EDGE_VOICE_PRESETS : VOICE_PRESETS) {
        console.log(`${voice.id}\t${voice.name}\t${voice.description}`)
      }
      return 0
    }

    const textFile = values['text-file']
    if ((values.text === undefined) === (textFile === undefined)) {
      throw new Error('Supply exactly one of --text and --text-file')
    }
    if (!values.output || path.extname(values.output).toLowerCase() !== '.mp3') {
      throw new Error('--output must be an .mp3 path')
    }
    if (!PROVIDER_IDS.includes(values.provider as (typeof PROVIDER_IDS)[number])) {
      throw new Error(`Unknown speech provider: ${values.provider}. Known: ${PROVIDER_IDS.join(', ')}`)
    }
    if (values.model && values.provider !== 'gemini-tts' && values.provider !== 'gemini-cloud') throw new Error('--model is supported with Gemini providers')
    const requestedVoice = values.provider === 'cloud' ? (values.voice ?? process.env.ELEVENLABS_VOICE_ID ?? '') :
      values.voice ?? (values.provider === 'gemini-cloud' ? INVESTIGATOR_VOICE_ID : values.provider === 'gemini-tts' ? DEFAULT_GEMINI_TTS_VOICE : values.provider === 'edge' ? EDGE_DEFAULT_VOICE_ID : DEFAULT_VOICE_ID)
    const voiceId = values.provider === 'gemini-cloud' && requestedVoice === ARCHIPELAGO_VOICE_ALIAS ? ARCHIPELAGO_VOICE_ID : requestedVoice
    if (values.provider === 'cloud' && (!process.env.ELEVENLABS_API_KEY || !voiceId)) {
      throw new Error('Cloud TTS requires ELEVENLABS_API_KEY and a voice ID (--voice or ELEVENLABS_VOICE_ID)')
    }
    if ((values.provider === 'gemini-tts' || values.provider === 'gemini-cloud') && !isGeminiCustomVoice(voiceId) && !GEMINI_TTS_VOICES.includes(voiceId as (typeof GEMINI_TTS_VOICES)[number])) {
      throw new Error(`Unknown Gemini TTS voice: ${voiceId}. Use --provider gemini-tts --list-voices.`)
    }
    if (values.provider === 'gemini-tts' && geminiApiKeys.length === 0) throw new Error('Gemini TTS requires GEMINI_API_KEY in .env, api.env, or the environment')
    let selectedGeminiKeys = geminiApiKeys
    if (values['gemini-key-index'] !== undefined) {
      if (values.provider !== 'gemini-tts' || !/^[1-9]\d*$/.test(values['gemini-key-index'])) throw new Error('--gemini-key-index requires a positive Gemini key index')
      const key = geminiApiKeys[Number(values['gemini-key-index']) - 1]
      if (!key) throw new Error('The selected Gemini key index is not configured')
      selectedGeminiKeys = [key]
    }
    if (values.provider !== 'cloud' && values.provider !== 'gemini-tts' && values.provider !== 'gemini-cloud' && !(values.provider === 'edge' ? findEdgeVoicePreset(voiceId) : findVoicePreset(voiceId))) {
      throw new Error(`Unknown voice: ${voiceId}. Use --list-voices to see the presets.`)
    }
    const text = (textFile === undefined
      ? values.text ?? ''
      : stripBom(await fs.readFile(textFile, 'utf8'))
    ).trim()
    if (!text || text.length > TTS_MAX_TEXT_LENGTH) {
      throw new Error(`Speech text must contain 1–${TTS_MAX_TEXT_LENGTH} characters`)
    }

    return await generateNarration(
      text,
      voiceId,
      path.resolve(values.output),
      !values['no-master'],
      values.provider,
      values['asr-model'],
      values.model,
      selectedGeminiKeys,
      values.provider === 'gemini-cloud' ? await resolveGoogleCloudProject() : undefined
    )
  } catch (error) {
    console.error(`[tts] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function generateNarration(
  text: string,
  voiceId: string,
  output: string,
  master: boolean,
  providerId: string,
  asrModel: string,
  model?: string,
  geminiApiKeys?: string[],
  googleCloudProject?: string
): Promise<number> {
  const destination = await fs.lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (destination) throw new Error(`Output already exists: ${output}`)
  for (const artifact of [`${stem(output)}-timestamps.json`, `${stem(output)}-report.json`]) {
    const existing = await fs.lstat(artifact).catch(() => undefined)
    if (existing) throw new Error(`Output already exists: ${artifact}`)
  }

  const dataDir = resolveDataDir()
  const settings = await loadSettings(dataDir)
  const { ffmpegPath } = await resolveFfmpegBinariesCached({ preference: settings.ffmpeg.source })
  const outputDir = path.dirname(output)
  await fs.mkdir(outputDir, { recursive: true })
  const resources = path.resolve(__dirname, '..', '..', 'resources', 'tts')
  // Fails fast with a readable message for an unknown --provider value.
  const provider = createProvider(providerId, {
    voxWorkerPath: path.join(resources, 'voxcpm_worker.py'), model, geminiApiKeys, googleCloudProject
  })
  const controller = new AbortController()
  const cancel = (): void => controller.abort()
  process.once('SIGINT', cancel)
  let artifacts: NarrationArtifacts
  try {
    artifacts = await runNarrationPipeline({
      script: text,
      voiceId,
      outputMp3: output,
      ffmpegPath,
      provider,
      asrWorkerPath: path.join(resources, 'asr_worker.py'),
      asrModel,
      referenceCacheDir: path.join(dataDir, 'cache', 'tts-voxcpm-references'),
      master,
      signal: controller.signal,
      onProgress: (info) => {
        if (info.phase === 'synthesizing' && info.chunk && info.totalChunks) {
          console.log(`[tts] chunk ${info.chunk}/${info.totalChunks}`)
        } else if (info.phase === 'resuming' && info.chunk) {
          console.log(`[tts] chunk ${info.chunk}: reused saved audio`)
        } else if (info.phase === 'mastering') {
          console.log('[tts] stitching and mastering')
        }
      }
    })
  } catch (error) {
    if (controller.signal.aborted) {
      console.error('[tts] cancelled')
      return 130
    }
    throw error
  } finally {
    process.removeListener('SIGINT', cancel)
    stopAsrWorker()
  }

  // Publish the staged artifacts without overwriting anything a concurrent
  // invocation may have created; roll back partial publishes.
  const { timestamps: finalTimestamps, report: finalReport } = await publishNarrationArtifacts(artifacts, output)

  console.log(output)
  console.log(finalTimestamps)
  console.log(finalReport)
  const q = artifacts.audioQuality
  if (q.integratedLufs !== null) {
    console.log(
      `[tts] loudness ${q.integratedLufs.toFixed(1)} LUFS · LRA ${q.loudnessRangeLu?.toFixed(1) ?? '?'} · ` +
        `noise floor ${q.noiseFloorDbfs?.toFixed(1) ?? '?'} dBFS`
    )
  }
  if (!artifacts.passed) {
    console.error(
      '[tts] narration FAILED verification — review the report before using this audio'
    )
    return 2
  }
  return 0
}

function stem(file: string): string {
  const ext = path.extname(file)
  return file.slice(0, file.length - ext.length)
}
