// ShortZ UI E2E — plain CDP over Node builtins (no Playwright; zero new deps,
// justified in tmp/NOTES-B.md).
//
//   node e2e/run.mjs        (or: pnpm test:ui)
//
// What it does: spawns `pnpm dev` with a random remote-debugging port, waits
// for the renderer, then asserts the shell contract (ui-spec): app opens,
// Home renders, a clip opens the Editor, the preview plays the file through
// media://, the safe-zone overlay toggles, trim handles drag + snap to 0.1 s,
// the export control reflects the engine state, and the renderer console
// stays clean.
//
// ENGINE-INDEPENDENCE (must stay green before AND after the render-core
// integration — see NOTES-B):
//   - Home "recent projects" accepts cards OR the empty state (the mock seeds
//     disappear once the real project store lands).
//   - Export control passes when disabled-with-pending-tooltip (mocked
//     engine) or enabled (integrated engine).
//   - The clip comes from fixtures/ when present, else a tmp fallback.

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = process.env.SHORTZ_E2E_PORT ?? String(9250 + Math.floor(Math.random() * 100))
const DEV_TIMEOUT_MS = 120_000

// ffprobe for artifact verification: bundled binary (always present after
// `pnpm install`), falling back to PATH.
const FFPROBE = (() => {
  const bundled = resolve(ROOT, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
  return existsSync(bundled) ? bundled : 'ffprobe'
})()

function findClip() {
  for (const c of ['fixtures/landscape_1080p_10s.mp4', 'tmp/test-clip.mp4']) {
    const p = resolve(ROOT, c)
    if (existsSync(p)) return p
  }
  throw new Error('No test clip found (expected fixtures/landscape_1080p_10s.mp4 or tmp/test-clip.mp4)')
}

// --- tiny runner -------------------------------------------------------------

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS ${name}`)
  } catch (err) {
    results.push({ name, ok: false, err })
    console.error(`FAIL ${name}: ${err.message}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// --- dev process + CDP -------------------------------------------------------

const devLogPath = resolve(ROOT, 'tmp', 'e2e-dev.log')
mkdirSync(resolve(ROOT, 'tmp'), { recursive: true })
const devLog = openSync(devLogPath, 'w')

// Stale instances hold the single-instance lock (userData is shared between
// dev and packaged builds) — sweep before spawning or our app quits instantly.
if (process.platform === 'win32') {
  for (const img of ['ShortZ.exe', 'electron.exe']) {
    try {
      spawn('taskkill', ['/F', '/IM', img, '/T'], { stdio: 'ignore' })
    } catch {
      /* none running */
    }
  }
  await new Promise((r) => setTimeout(r, 1500))
}

const dev = spawn('pnpm', ['dev'], {
  cwd: ROOT,
  shell: true,
  env: { ...process.env, SHORTZ_REMOTE_DEBUGGING: PORT, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
dev.stdout.on('data', (d) => writeSync(devLog, d))
dev.stderr.on('data', (d) => writeSync(devLog, d))

async function waitForPage() {
  const deadline = Date.now() + DEV_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && t.url && !t.url.startsWith('about:'))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`dev server did not expose a page on port ${PORT} within ${DEV_TIMEOUT_MS / 1000}s (see ${devLogPath})`)
}

let ws
let msgId = 0
const pending = new Map()
const consoleErrors = []
// Set by the export test, consumed by the exportHistory test.
let exportArtifact = null

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
  }
  return r.result.result.value
}

function killDev() {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(dev.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* best effort */
    }
  } else {
    try {
      dev.kill('SIGTERM')
    } catch {
      /* best effort */
    }
  }
}

async function dragElement(selector, targetX, y) {
  // Scroll into view first: Input.dispatchMouseEvent rejects coordinates
  // outside the viewport ("Invalid parameters") and the trim bar can sit
  // below the fold inside the scrollable preview pane.
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  assert(box, `${selector} not visible for dragging`)
  const clamp = (v, lo, hi) => Math.min(Math.max(Math.round(v), lo), hi)
  const vw = await evaluate(`innerWidth`)
  const vh = await evaluate(`innerHeight`)
  const startX = clamp(box.x, 0, vw - 1)
  const startY = clamp(box.y, 0, vh - 1)
  const endX = clamp(targetX, 0, vw - 1)
  const endY = clamp(y, 0, vh - 1)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      // CDP Input.dispatchMouseEvent takes integer coordinates.
      x: Math.round(startX + ((endX - startX) * i) / 6),
      y: endY,
      button: 'left',
      buttons: 1
    })
    await new Promise((r) => setTimeout(r, 30))
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endX, y: endY, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left' })
  await new Promise((r) => setTimeout(r, 200))
}

// --- the suite ------------------------------------------------------------------

const clip = findClip()
let page
try {
  page = await waitForPage()
} catch (err) {
  console.error(String(err.message))
  killDev()
  process.exit(1)
}

ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('CDP websocket failed'))
})
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) rej(new Error(m.error.message))
    else res(m)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(`EXCEPTION: ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`)
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
}
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })

async function waitFor(expression, timeoutMs = 12_000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await evaluate(expression)
    if (v) return v
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`timeout waiting for ${what}`)
}

await test('app opens to Home (drop zone + recent section)', async () => {
  const home = await waitFor(`(() => {
    const home = !!document.querySelector('.home')
    const dropzone = !!document.querySelector('.dropzone')
    // waitFor is truthy-driven: objects never lie about absence — return
    // null until the actual contract (home + dropzone) holds.
    return home && dropzone ? { home, dropzone, cards: document.querySelectorAll('.project-card').length, empty: !!document.querySelector('.home__empty') } : null
  })()`, 15_000, 'Home to render')
  assert(home, 'home/dropzone not rendered')
  assert(home.cards > 0 || home.empty, 'neither project cards nor empty state rendered')
})

let editorUp = false
await test('opening a clip reaches the Editor (three panes, phone frame)', async () => {
  assert(await evaluate(`typeof window.__shortzDev === 'object'`), 'dev hook missing (dev-only — suite must run against pnpm dev)')
  // Fire-and-poll: awaiting the store promise inside Runtime.evaluate races
  // context churn during the screen switch ("Promise was collected").
  await evaluate(`void window.__shortzDev.openPath(${JSON.stringify(clip.replace(/\\/g, '/'))}); true`)
  await waitFor(`(() => {
    const ta = document.querySelector('textarea')
    return ta ? ta.id : null
  })()`, 10_000, 'hook textarea')

  // First-usage fix coverage: with the hook still EMPTY the preview must be
  // live (phone frame + media:// video + ghost slot, duration loaded) while
  // export stays disabled — a required input must never blank the preview.
  const emptyState = await waitFor(`(() => {
    const phone = !!document.querySelector('.phone-frame')
    const video = document.querySelector('.video-layer:not(.video-layer--blurbg)')
    const ghost = !!document.querySelector('.ghost-slot')
    const ex = document.querySelector('.editor__topbar .btn-primary')
    if (!phone || !video || video.readyState < 1) return null
    return { ghost, disabled: ex ? ex.disabled : null, title: ex ? (ex.title ?? '') : '', dur: video.duration }
  })()`, 15_000, 'live preview with an empty hook')
  assert(emptyState.disabled === true, `export must stay disabled with an empty hook (title "${emptyState.title}")`)
  assert(/hook/i.test(emptyState.title), `export tooltip should point at the hook ("${emptyState.title}")`)
  assert(emptyState.dur > 0, 'video duration did not load with an empty hook')
  assert(emptyState.ghost, 'ghost slot missing for the empty required hook')

  // Typing the hook brings the full text layer + an enabled export.
  await evaluate(`(() => {
    const ta = document.querySelector('textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, 'A wildlife photographer put a microphone beside a baby squirrel')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  const ed = await waitFor(`(() => {
    const editor = document.querySelector('.editor')
    if (!editor) return null
    const panes = [document.querySelector('.template-picker'), document.querySelector('.editor__preview-pane'), document.querySelector('.field-panel')]
    if (!panes.every(Boolean)) return null
    const phone = !!document.querySelector('.phone-frame')
    return phone ? { phone } : null
  })()`, 15_000, 'Editor three panes')
  assert(ed.phone, 'phone frame missing')
  editorUp = true
})

let videoOk = false
await test('preview video loads through media://', async () => {
  assert(editorUp, 'skipped: editor never rendered')
  const v = await waitFor(`(() => {
    const el = document.querySelector('.video-layer:not(.video-layer--blurbg)')
    if (!el || el.readyState < 2) return null
    const src = el.getAttribute('src') ?? ''
    if (!src.startsWith('media://')) return { badSrc: src }
    return { src, ready: el.readyState, w: el.videoWidth, h: el.videoHeight }
  })()`, 15_000, 'video ready via media://')
  assert(!v.badSrc, `video src not media://: ${String(v.badSrc).slice(0, 40)}`)
  assert(v.w > 0 && v.h > 0, `video dimensions unknown (${v.w}x${v.h})`)
  videoOk = true
})

await test('safe-zone overlay toggles', async () => {
  const before = await evaluate(`!!document.querySelector('.safe-zone-overlay')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Safe zones')).click()`)
  await new Promise((r) => setTimeout(r, 250))
  const after = await evaluate(`!!document.querySelector('.safe-zone-overlay')`)
  assert(before !== after, `overlay did not toggle (before=${before}, after=${after})`)
  if (!before) {
    // leave it ON (default) for the next test
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Safe zones')).click()`)
    await new Promise((r) => setTimeout(r, 200))
  }
})

await test('trim handle drags and snaps to 0.1 s', async () => {
  assert(videoOk, 'skipped: video never loaded (duration unknown)')
  const before = await evaluate(`document.querySelector('.trim-range__handle[aria-label="Trim end"] .trim-range__value')?.textContent ?? ''`)
  const track = await evaluate(`(() => {
    const t = document.querySelector('.trim-range__track')
    if (!t) return null
    const r = t.getBoundingClientRect()
    return { x: r.x, w: r.width, y: r.y + r.height / 2 }
  })()`)
  assert(track, 'trim track not visible')
  // Drag the end handle to ~63% of the track (clip duration 10 s → ≈6.3 s).
  await dragElement('.trim-range__handle[aria-label="Trim end"]', track.x + track.w * 0.63, track.y)
  const label = await evaluate(`document.querySelector('.trim-range__handle[aria-label="Trim end"] .trim-range__value')?.textContent ?? ''`)
  assert(label !== before, `trim end label unchanged (${label})`)
  const m = /^(\d+\.\d)s$/.exec(label)
  assert(m, `trim label not snapped to one decimal: "${label}"`)
})

await test('export control reflects engine state (disabled+pending or enabled)', async () => {
  const ex = await evaluate(`(() => {
    const b = document.querySelector('.editor__topbar .btn-primary')
    if (!b) return null
    return { disabled: b.disabled, title: b.title ?? '' }
  })()`)
  assert(ex, 'export button missing')
  // Pre-integration: disabled with a "pending" tooltip. Post-integration:
  // enabled. Both are the correct state for their respective build.
  assert(ex.disabled ? /pending/i.test(ex.title) : true, `export disabled but tooltip is not engine-pending: "${ex.title}"`)
})

// --- full product loop: drop → template → hook → preview → export → probe ------
// This is the integration proof (docs/01-goals.md A1). It runs the REAL engine
// through the REAL IPC + orchestrator and inspects the artifact on disk.

await test('export runs the real engine and produces a TikTok-ready MP4', async () => {
  assert(editorUp, 'skipped: editor never rendered')
  const enabled = await evaluate(`(() => {
    const b = document.querySelector('.editor__topbar .btn-primary')
    return b ? !b.disabled : false
  })()`)
  assert(enabled, 'export button disabled after a valid hook — integration not wired')

  // Snapshot the output dir so we identify exactly the artifact this run makes.
  const outDir = process.env.SHORTZ_E2E_OUTDIR || join(homedir(), 'Videos', 'ShortZ')
  const before = new Set(existsSync(outDir) ? readdirSync(outDir) : [])

  await evaluate(`document.querySelector('.editor__topbar .btn-primary').click(); true`)

  // The render bar appears while the job runs and disappears when it settles.
  const sawBusy = await waitFor(`!!document.querySelector('.export-bar--busy')`, 10_000, 'render bar to appear')
  assert(sawBusy, 'render bar never appeared — export did not start')

  const settled = await waitFor(`(() => {
    const busy = !!document.querySelector('.export-bar--busy')
    const err = document.querySelector('.export-bar--error')
    if (err) return { failed: err.textContent.slice(0, 400) }
    return busy ? null : { done: true }
  })()`, 180_000, 'export to finish')
  assert(!settled.failed, `export failed: ${settled.failed}`)

  // Exactly one new MP4 in the output dir.
  const after = (existsSync(outDir) ? readdirSync(outDir) : []).filter(
    (f) => f.toLowerCase().endsWith('.mp4') && !before.has(f)
  )
  assert(after.length === 1, `expected 1 new mp4 in ${outDir}, got ${after.length}: ${after.join(', ')}`)
  const artifact = resolve(outDir, after[0])

  // Artifact contract (A1): 1080×1920, h264, yuv420p, aac stereo, faststart.
  const probe = JSON.parse(
    execFileSync(FFPROBE, ['-v', 'error', '-show_entries',
      'format=duration,size:stream=codec_type,codec_name,width,height,pix_fmt,channels,sample_rate',
      '-of', 'json', artifact], { encoding: 'utf8' })
  )
  const v = probe.streams.find((s) => s.codec_type === 'video')
  const a = probe.streams.find((s) => s.codec_type === 'audio')
  assert(v, 'no video stream in export')
  assert(v.width === 1080 && v.height === 1920, `wrong dimensions ${v.width}x${v.height}`)
  assert(v.codec_name === 'h264', `wrong video codec ${v.codec_name}`)
  assert(v.pix_fmt === 'yuv420p', `wrong pixel format ${v.pix_fmt} (TikTok needs yuv420p)`)
  assert(a, 'no audio stream in export')
  assert(a.codec_name === 'aac' && a.channels === 2, `audio not AAC stereo (${a.codec_name}/${a.channels})`)
  assert(Number(a.sample_rate) === 48000, `audio not 48 kHz (${a.sample_rate})`)

  // faststart: moov precedes mdat.
  const buf = readFileSync(artifact)
  const moov = buf.indexOf(Buffer.from('moov'))
  const mdat = buf.indexOf(Buffer.from('mdat'))
  assert(moov > 0 && mdat > 0 && moov < mdat, `not faststart (moov=${moov}, mdat=${mdat})`)

  exportArtifact = artifact
})

await test('export is recorded in the project exportHistory', async () => {
  assert(exportArtifact, 'skipped: no export artifact this run')
  // The renderer reloads the project after a successful export; the persisted
  // document is the source of truth for the history entry.
  const recorded = await evaluate(`(async () => {
    const list = await window.shortz.listProjects()
    const newest = list[0]
    if (!newest) return null
    const p = await window.shortz.openProject(newest.id)
    return { history: p.exportHistory ?? [], sourcePath: p.source.path }
  })()`)
  assert(recorded, 'no project found after export')
  const entry = recorded.history.find((h) => resolve(h.path) === resolve(exportArtifact))
  assert(entry, `artifact ${exportArtifact} not in exportHistory (${recorded.history.length} entries)`)
  assert(entry.sizeBytes > 0, 'exportHistory entry has no size')
  assert(entry.durationSec > 0, 'exportHistory entry has no duration')
})

await test('renderer console is clean', async () => {
  const allow = (e) => e.includes('react-devtools') || e.includes('Download the React DevTools')
  const real = consoleErrors.filter((e) => !allow(e))
  assert(real.length === 0, `console errors:\n  ${real.join('\n  ')}`)
})

// --- report ---------------------------------------------------------------------

const failed = results.filter((r) => !r.ok)
console.log('---')
console.log(`${results.length - failed.length}/${results.length} passed`)
ws?.close()
killDev()
setTimeout(() => process.exit(failed.length > 0 ? 1 : 0), 1500)
