import fs from 'node:fs/promises'
import path from 'node:path'
import type { NarrationArtifacts } from './pipeline'

/** Publish all narration artifacts exclusively, preserving the resume cache on failure. */
export async function publishNarrationArtifacts(artifacts: NarrationArtifacts, output: string): Promise<{ timestamps: string; report: string }> {
  const stem = output.slice(0, output.length - path.extname(output).length)
  const timestamps = `${stem}-timestamps.json`
  const report = `${stem}-report.json`
  const published: string[] = []
  let publishedAll = false
  try {
    for (const [staged, final] of [[artifacts.mp3, output], [artifacts.timestamps, timestamps], [artifacts.report, report]] as const) {
      await fs.link(staged, final)
      published.push(final)
    }
    publishedAll = true
    return { timestamps, report }
  } catch (error) {
    for (const file of published) await fs.unlink(file).catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Output already exists (created during generation)')
    throw error
  } finally {
    await artifacts.cleanup({ preserveCache: !publishedAll })
  }
}
