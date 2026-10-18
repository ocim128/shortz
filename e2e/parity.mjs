// ShortZ preview↔render parity check (docs/01-goals.md A2 / goal G3).
//
//   node e2e/parity.mjs
//
// Method
// ------
// The preview and the render must agree because they run the SAME shared layout
// engine (src/shared/layout) over the SAME font bytes. This harness proves it
// empirically at t=2 s:
//
//   1. Build a parity project: the shipped sample fixture, with trim set to the
//      full clip (0–10 s) and the source path made absolute. Zero trim keeps
//      source time == output time, so preview t=2 s and render t=2 s refer to
//      the same source frame.
//   2. Render it through the real headless engine (`pnpm cli render`) and
//      extract the frame at t=2 s, scaled 1080×1920 → 390×693.
//   3. Launch the real app (pnpm dev + CDP), open the same clip, type the same
//      hook (the sample's default knobs are exactly the template defaults, so
//      a fresh project resolves to the same layout), seek the preview to 2 s,
//      hide the preview-only safe-zone overlay, and screenshot the phone frame.
//   4. Compare after cropping a 6 px inset per side: the phone frame carries a
//      1 px border and an 18 px corner radius, and the screenshot edge is
//      antialiased — none of which exist in the render.
//
// Reported: mean absolute channel error and the share of pixels differing by
// more than 24/255, overall and per band (hook text, video, background).
// A2 asks for "same text position/size/color, same video placement within ~2px"
// — not byte equality — so the pass criteria are structural: the text band and
// video band must both show strong agreement, and overall MAE must stay low.

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeFileSync, writeSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TMP = resolve(ROOT, 'tmp')
const PORT = process.env.SHORTZ_E2E_PORT ?? String(9450 + Math.floor(Math.random() * 50))
const SAMPLE = resolve(ROOT, 'fixtures', 'sample-project.json')
const CLIP = resolve(ROOT, 'fixtures', 'landscape_1080p_10s.mp4')

const FFMPEG = (() => {
  const bundled = resolve(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  return existsSync(bundled) ? bundled : 'ffmpeg'
})()

const PREVIEW_W = 390
const PREVIEW_H = 693
const INSET = 6

mkdirSync(TMP, { recursive: true })

// --- 1. the parity project ---------------------------------------------------

const fixture = JSON.parse(readFileSync(SAMPLE, 'utf8'))
const parityProject = {
  ...fixture,
  source: { ...fixture.source, path: CLIP },
  trim: { start: 0, end: 10 }
}
const parityProjectPath = join(TMP, 'parity-project.json')
writeFileSync(parityProjectPath, JSON.stringify(parityProject, null, 2))

// --- 2. render + extract the reference frame ---------------------------------

const renderOut = join(TMP, 'parity-render.mp4')
console.log('[parity] rendering the parity project through the headless engine…')
execFileSync(
  process.execPath,
  [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'cli', 'index.ts'), 'render', parityProjectPath, '-o', renderOut],
  { cwd: ROOT, stdio: 'inherit' }
)
if (!existsSync(renderOut)) throw new Error(`render produced no output at ${renderOut}`)

const renderFramePath = join(TMP, 'parity-render-2s.png')
execFileSync(
  FFMPEG,
  ['-y', '-ss', '2', '-i', renderOut, '-frames:v', '1', '-vf', `scale=${PREVIEW_W}:${PREVIEW_H}`, renderFramePath],
  { stdio: 'ignore' }
)

// --- 3. screenshot the live preview at t=2 s ---------------------------------

for (const img of ['ShortZ.exe', 'electron.exe']) {
  try {
    spawn('taskkill', ['/F', '/IM', img, '/T'], { stdio: 'ignore' })
  } catch {
    /* none running */
  }
}
await new Promise((r) => setTimeout(r, 1500))

const devLog = openSync(join(TMP, 'parity-dev.log'), 'w')
const dev = spawn('pnpm', ['dev'], {
  cwd: ROOT,
  shell: true,
  env: { ...process.env, SHORTZ_REMOTE_DEBUGGING: PORT },
  stdio: ['ignore', 'pipe', 'pipe']
})
dev.stdout.on('data', (d) => writeSync(devLog, d))
dev.stderr.on('data', (d) => writeSync(devLog, d))

let page = null
for (let i = 0; i < 120 && !page; i++) {
  try {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
    page = list.find((t) => t.type === 'page' && t.url && !t.url.startsWith('about:'))
  } catch {
    /* not up yet */
  }
  if (!page) await new Promise((r) => setTimeout(r, 1000))
}
if (!page) {
  console.error('[parity] dev server never exposed a page; see tmp/parity-dev.log')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('CDP websocket failed'))
})
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
  }
  return r.result.result.value
}
async function waitFor(expression, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await evaluate(expression)
    if (v) return v
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`timeout waiting for ${what}`)
}

await send('Runtime.enable')
await send('Page.enable')
await new Promise((r) => setTimeout(r, 3000))

const hook = parityProject.values.fields.hook
await evaluate(`void window.__shortzDev.openPath(${JSON.stringify(CLIP.replace(/\\/g, '/'))}); true`)
await waitFor(`!!document.querySelector('textarea')`, 20_000, 'hook textarea')
await evaluate(`(() => {
  const ta = document.querySelector('textarea')
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  set.call(ta, ${JSON.stringify(hook)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

// The shared layout engine must have resolved and painted the text canvas.
await waitFor(`(() => !!document.querySelector('.text-canvas'))()`, 20_000, 'preview layout')
await waitFor(
  `(() => { const v = document.querySelector('.video-layer:not(.video-layer--blurbg)'); return v && v.readyState >= 2 ? true : null })()`,
  20_000,
  'preview video'
)

// The safe-zone overlay is a preview-only affordance — the render has no equivalent.
await evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Safe zones'))
  if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click()
  return true
})()`)

// Seek to exactly 2.000 s and wait for the decoded frame.
const seek = await evaluate(`(async () => {
  const v = document.querySelector('.video-layer:not(.video-layer--blurbg)')
  if (!v) return { error: 'no video element' }
  v.pause()
  await new Promise((res) => {
    const done = () => res(null)
    v.addEventListener('seeked', done, { once: true })
    v.currentTime = 2
    setTimeout(done, 4000)
  })
  return { t: v.currentTime, ready: v.readyState }
})()`)
if (seek.error) throw new Error(`preview seek failed: ${seek.error}`)
if (Math.abs(seek.t - 2) > 0.05) throw new Error(`preview did not seek to 2 s (got ${seek.t})`)
await new Promise((r) => setTimeout(r, 800))

const box = await evaluate(`(() => {
  const el = document.querySelector('.phone-frame')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})()`)
if (!box) throw new Error('phone frame not found')

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
    scale: 1
  }
})
const previewFramePath = join(TMP, 'parity-preview-2s.png')
writeFileSync(previewFramePath, Buffer.from(shot.result.data, 'base64'))

ws.close()
try {
  spawn('taskkill', ['/PID', String(dev.pid), '/T', '/F'], { stdio: 'ignore' })
} catch {
  /* best effort */
}

// --- 4. compare ---------------------------------------------------------------

const analysis = execFileSync(
  process.execPath,
  [join(ROOT, 'e2e', 'parity-compare.mjs'), previewFramePath, renderFramePath, String(INSET)],
  { encoding: 'utf8' }
)
const result = JSON.parse(analysis)

console.log('\n[parity] preview:', previewFramePath)
console.log('[parity] render :', renderFramePath)
console.log('[parity]', JSON.stringify(result, null, 2))

const ok =
  // Agreement
  result.overall.mae < 18 &&
  result.bands.text.mae < 30 &&
  result.bands.video.mae < 18 &&
  // Both frames must actually contain content (guards a vacuous comparison).
  result.ink.text.preview > 0.01 &&
  result.ink.text.render > 0.01 &&
  result.ink.video.preview > 0.2 &&
  result.ink.video.render > 0.2

console.log(
  `\n[parity] text-band ink ${(result.ink.text.preview * 100).toFixed(2)}% vs ` +
    `${(result.ink.text.render * 100).toFixed(2)}% · video-band lit ` +
    `${(result.ink.video.preview * 100).toFixed(1)}% vs ${(result.ink.video.render * 100).toFixed(1)}%`
)
console.log(`[parity] ${ok ? 'PASS' : 'FAIL'} — A2 preview↔render spot-check at t=2 s`)
process.exit(ok ? 0 : 1)
