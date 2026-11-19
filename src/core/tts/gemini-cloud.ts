import path from 'node:path'
import { GoogleAuth } from 'google-auth-library'
import { createGeminiTtsProvider } from './gemini-tts'
import type { TtsProvider } from './provider'

/** Gemini 3.8 through Google Cloud Agent Platform using Application Default Credentials. */
export function createGeminiCloudProvider(options: {
  project?: string
  model?: string
  getToken?: () => Promise<string | null | undefined>
  fetchImpl?: typeof fetch
} = {}): TtsProvider {
  const project = options.project?.trim()
  if (!project || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(project)) {
    throw new Error('Set SHORTZ_GOOGLE_CLOUD_PROJECT to the Google Cloud project owning the Investigator voice')
  }
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const getToken = options.getToken ?? (() => auth.getAccessToken())
  const model = options.model ?? 'gemini-3.8-flash-tts'
  const provider = createGeminiTtsProvider({
    model,
    apiKey: 'cloud-auth',
    fetchImpl: async (_url, init) => {
      const token = await getToken()
      if (!token) throw new Error('Google Cloud sign-in is required for Investigator narration')
      const headers = new Headers(init?.headers)
      headers.delete('x-goog-api-key')
      headers.set('authorization', `Bearer ${token}`)
      const body = JSON.parse(String(init?.body)) as {
        generationConfig: { speechConfig: { voiceConfig: { voice?: string; prebuiltVoiceConfig?: { voiceName: string } } } }
      }
      const voiceConfig = body.generationConfig.speechConfig.voiceConfig
      if (voiceConfig.prebuiltVoiceConfig) {
        voiceConfig.voice = voiceConfig.prebuiltVoiceConfig.voiceName
        delete voiceConfig.prebuiltVoiceConfig
      }
      const response = await (options.fetchImpl ?? fetch)(
        `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}:generateContent`,
        { ...init, headers, body: JSON.stringify(body) }
      )
      if (response.status === 403) {
        const payload = await response.clone().json().catch(() => ({})) as {
          error?: { status?: string; message?: string; details?: Array<{ reason?: string }> }
        }
        const reason = payload.error?.details?.find((detail) => detail.reason)?.reason
        if (payload.error?.message?.includes('eligible paid billing account in a supported region')) {
          throw new Error('Google Cloud Gemini requires an eligible paid billing account in a supported region')
        }
        throw new Error(`Google Cloud Gemini access denied (HTTP 403${reason ? `; ${reason}` : ''})`)
      }
      return response
    }
  })
  return {
    id: 'gemini-cloud', model,
    synthesizeChunk: (request, context) => provider.synthesizeChunk(request, {
      ...context,
      ...(context.geminiCacheDir ? { geminiCacheDir: path.join(context.geminiCacheDir, project) } : {})
    }),
    stop: () => provider.stop()
  }
}
