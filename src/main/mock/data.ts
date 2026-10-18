import path from 'node:path'
import type { Project, ProjectMeta, Settings, TemplateMeta } from '../../preload/api'

/**
 * In-memory mock store backing the IPC handlers until Agent A's src/core
 * lands (see tmp/NOTES-B.md integration checklist). No files are written —
 * persistence is A's src/core/store lane.
 *
 * The full template BODIES live in the renderer (renderer/src/mock/templates.ts,
 * per the agent split); this mock returns metas only and the renderer joins
 * on id.
 */

const now = () => new Date().toISOString()
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

// --- templates -------------------------------------------------------------

export const mockTemplates: TemplateMeta[] = [
  {
    id: 'hook-letterbox',
    name: 'Hook Letterbox',
    description: 'Clip letterboxed upper-center, bold hook on top. Classic story opener.',
    badge: 'built-in',
    valid: true
  },
  {
    id: 'blur-letterbox',
    name: 'Blur Letterbox',
    description: 'Blurred fullscreen copy behind the letterboxed clip — the repost look.',
    badge: 'built-in',
    valid: true
  },
  {
    id: 'my-giant-text',
    name: 'my-giant-text',
    description: 'User template (invalid)',
    badge: 'user',
    valid: false,
    error: 'slots[1].anchor: computed height (video.y − gap) − minY = 96px, below the 120px minimum for aboveVideo slots'
  }
]

// --- projects ---------------------------------------------------------------

function makeProject(p: Partial<Project> & Pick<Project, 'id' | 'name' | 'source'>): Project {
  return {
    schemaVersion: 1,
    createdAt: hoursAgo(2),
    updatedAt: hoursAgo(2),
    templateId: 'hook-letterbox',
    values: {
      fields: {
        hook: 'A wildlife photographer put a microphone beside a baby squirrel. These are its actual eating sounds.'
      },
      knobs: {}
    },
    trim: { start: 0, end: 0 },
    audio: 'keep',
    exportHistory: [],
    ...p
  }
}

const seedProjects: Project[] = [
  makeProject({
    id: '01J8GZ5X7Y4Q9A3M2K6VB1C0D5',
    name: 'air-17oct2026',
    createdAt: hoursAgo(2),
    updatedAt: hoursAgo(2),
    source: {
      path: 'D:\\clips\\air-17oct2026.mp4',
      probe: { width: 1920, height: 1080, fps: 30, duration: 27.4, hasAudio: true, videoCodec: 'h264' }
    },
    trim: { start: 3.2, end: 21.0 },
    exportHistory: [
      {
        path: 'C:\\Users\\user\\Videos\\ShortZ\\air-17oct2026_20261018_0935.mp4',
        createdAt: hoursAgo(1.9),
        durationSec: 17.8,
        sizeBytes: 19_847_211,
        encoder: 'libx264',
        crf: 18
      }
    ]
  }),
  makeProject({
    id: '01J8FK2M9Z3P7Q5R1T8WX4Y6Z0',
    name: 'fox-clip',
    createdAt: hoursAgo(26),
    updatedAt: hoursAgo(26),
    templateId: 'blur-letterbox',
    source: {
      path: 'D:\\clips\\fox-clip.mp4',
      probe: { width: 1280, height: 720, fps: 30, duration: 41.2, hasAudio: true, videoCodec: 'h264' }
    },
    trim: { start: 0, end: 41.2 }
  }),
  makeProject({
    id: '01J8A01B5C8D2E4F6G8H0J2K4L',
    name: 'gym-compilation',
    createdAt: hoursAgo(72),
    updatedAt: hoursAgo(71),
    source: {
      // Deliberately missing → Home shows the orange ⚠ re-link state.
      path: 'E:\\old-drive\\gym-compilation.mov',
      probe: null,
      missing: true
    },
    trim: { start: 0, end: 0 }
  })
]

export const projects = new Map<string, Project>(seedProjects.map((p) => [p.id, p]))

export function toMeta(p: Project): ProjectMeta {
  return {
    id: p.id,
    name: p.name,
    templateId: p.templateId,
    updatedAt: p.updatedAt,
    sourceMissing: p.source.missing === true,
    thumbAvailable: false
  }
}

export function touch(p: Project): void {
  p.updatedAt = now()
}

// --- settings ----------------------------------------------------------------

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    output: {
      dir: path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Videos', 'ShortZ'),
      filenamePattern: '{name}_{yyyyMMdd}_{HHmm}'
    },
    encoder: { preferred: 'auto', crf: 18, fps: 30 },
    ffmpeg: { source: 'auto' },
    ui: { safeZonesDefault: true, lastProjectId: null }
  }
}

export let mockSettings: Settings = defaultSettings()

export function setMockSettings(s: Settings): Settings {
  mockSettings = s
  return mockSettings
}

// --- ids ----------------------------------------------------------------------

let idCounter = 0

export function nextMockId(): string {
  // Not a real ULID — only unique within this session (A's `ulid` replaces it).
  idCounter += 1
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase()
  return `MOCK${Date.now().toString(36).toUpperCase()}${idCounter.toString(36).toUpperCase()}${rand}`.padEnd(26, '0')
}
