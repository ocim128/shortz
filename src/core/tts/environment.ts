import fs from 'node:fs/promises'
import { parseEnv } from 'node:util'

/** Ordered configuration names; key 1 deliberately has no numeric suffix. */
export const GEMINI_API_KEY_NAMES = [
  'GEMINI_API_KEY', 'GEMINI_API_KEY2', 'GEMINI_API_KEY3', 'GEMINI_API_KEY4',
  'GEMINI_API_KEY5', 'GEMINI_API_KEY6', 'GEMINI_API_KEY7'
] as const

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
    providerDefault: env.SHORTZ_TTS_PROVIDER ?? localEnv.SHORTZ_TTS_PROVIDER ?? 'gemini-cloud',
    geminiApiKeys: GEMINI_API_KEY_NAMES
      .map((name) => (env[name] ?? localEnv[name])?.trim())
      .filter((key): key is string => Boolean(key))
  }
}

/** Cloud project owning the selected designed voice. */
export async function resolveGoogleCloudProject(
  file = '.env', env: NodeJS.ProcessEnv = process.env,
  fallbackFile: string | undefined = file === '.env' ? 'api.env' : undefined
): Promise<string | undefined> {
  const read = async (name: string): Promise<NodeJS.Dict<string>> => {
    const contents = await fs.readFile(name, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    return parseEnv(contents)
  }
  const local = { ...(fallbackFile ? await read(fallbackFile) : {}), ...await read(file) }
  return (env.SHORTZ_GOOGLE_CLOUD_PROJECT ?? local.SHORTZ_GOOGLE_CLOUD_PROJECT)?.trim() || undefined
}
