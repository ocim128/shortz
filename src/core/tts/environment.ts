import fs from 'node:fs/promises'
import { parseEnv } from 'node:util'

/** Process environment takes precedence over .env, then api.env. */
export async function resolveTtsEnvironment(
  file = '.env', env: NodeJS.ProcessEnv = process.env,
  fallbackFile: string | undefined = file === '.env' ? 'api.env' : undefined
): Promise<{ providerDefault: string; geminiApiKeys: string[] }> {
  const readEnv = async (name: string): Promise<NodeJS.Dict<string>> => {
    const contents = await fs.readFile(name, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    return parseEnv(contents)
  }
  const localEnv = { ...(fallbackFile ? await readEnv(fallbackFile) : {}), ...await readEnv(file) }
  return {
    providerDefault: env.SHORTZ_TTS_PROVIDER ?? localEnv.SHORTZ_TTS_PROVIDER ?? 'gemini-tts',
    geminiApiKeys: ['GEMINI_API_KEY', 'GEMINI_API_KEY2', 'GEMINI_API_KEY3']
      .map((name) => (env[name] ?? localEnv[name])?.trim())
      .filter((key): key is string => Boolean(key))
  }
}
