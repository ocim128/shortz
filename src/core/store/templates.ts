import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  describeTemplateIssues,
  validateTemplate,
  type ValidationIssue
} from '../../shared/template/validate'
import type { Template } from '../../shared/template/types'
import { stripBom } from './fs-utils'

export interface LoadedTemplate {
  template: Template | null
  sourcePath: string
  /** Empty when the template is valid. */
  issues: ValidationIssue[]
}

export interface TemplateMeta {
  id: string
  name: string
  description: string
  thumbnail: string
  sourcePath: string
  valid: boolean
  issues: ValidationIssue[]
}

export async function loadTemplateFile(filePath: string): Promise<LoadedTemplate> {
  let raw: unknown
  try {
    raw = JSON.parse(stripBom(await fs.readFile(filePath, 'utf8')))
  } catch (error) {
    return {
      template: null,
      sourcePath: filePath,
      issues: [{ path: '', message: `could not parse: ${(error as Error).message}` }]
    }
  }
  const result = validateTemplate(raw)
  if (!result.ok) {
    return { template: null, sourcePath: filePath, issues: result.issues }
  }
  return { template: result.template, sourcePath: filePath, issues: [] }
}

export async function loadTemplateById(
  resourcesDir: string,
  templateId: string
): Promise<Template> {
  const filePath = path.join(resourcesDir, 'templates', `${templateId}.json`)
  const loaded = await loadTemplateFile(filePath)
  if (!loaded.template) {
    throw new Error(
      `Template "${templateId}" is invalid or missing (${filePath}):\n${describeTemplateIssues(loaded.issues)}`
    )
  }
  return loaded.template
}

export async function listTemplates(templatesDir: string): Promise<TemplateMeta[]> {
  let files: string[]
  try {
    files = await fs.readdir(templatesDir)
  } catch {
    return []
  }
  const metas: TemplateMeta[] = []
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const loaded = await loadTemplateFile(path.join(templatesDir, file))
    if (loaded.template) {
      const t = loaded.template
      metas.push({
        id: t.id,
        name: t.name,
        description: t.description,
        thumbnail: t.thumbnail,
        sourcePath: loaded.sourcePath,
        valid: true,
        issues: []
      })
    } else {
      metas.push({
        id: path.basename(file, '.json'),
        name: path.basename(file, '.json'),
        description: '',
        thumbnail: '',
        sourcePath: loaded.sourcePath,
        valid: false,
        issues: loaded.issues
      })
    }
  }
  return metas.sort((a, b) => a.name.localeCompare(b.name))
}
