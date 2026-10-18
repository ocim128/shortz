import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFontBufferLoader } from '../../src/core/render/fonts'
import { assertValidTemplate } from '../../src/shared/template/validate'
import type { Template } from '../../src/shared/template/types'

const here = path.dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = path.resolve(here, '..', '..')
export const FONTS_DIR = path.join(REPO_ROOT, 'resources', 'fonts')
export const TEMPLATES_DIR = path.join(REPO_ROOT, 'resources', 'templates')
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures')
export const GOLDEN_DIR = path.join(REPO_ROOT, 'tests', 'golden')

/** fs-backed font loader — the same bytes the CLI and Electron main inject. */
export const loadFont = createFontBufferLoader(FONTS_DIR)

export function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name)
}

export function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

export function loadTemplateAt(filePath: string): Template {
  return assertValidTemplate(readJson(filePath))
}

export function loadHookTemplate(): Template {
  return loadTemplateAt(path.join(TEMPLATES_DIR, 'hook-letterbox.json'))
}

export async function makeScratchDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `shortz-tests-${prefix}-`))
}

export async function removeScratchDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
