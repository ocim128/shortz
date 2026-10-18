// Packaged-app verification (P0 evidence for NOTES-B).
// Launches the BUILT exe (not dev) with native --remote-debugging-port and
// asserts: Home renders, security flags hold in prod, media:// playback works
// outside dev (protocol + paths behave differently in production), and an
// Editor renders from a (missing-source) project card with the relink banner.
//
//   node tmp/verify-packaged.mjs [path-to-exe]
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const EXE = resolve(ROOT, process.argv[2] ?? process.argv[2] ?? 'dist/win-unpacked/ShortZ.exe')
const PORT = '9227'
const CLIP = resolve(ROOT, 'fixtures/landscape_1080p_10s.mp4').replace(/\\/g, '/')

if (!existsSync(EXE)) throw new Error(`exe not found: ${EXE}`)
if (!existsSync(CLIP.replace(/\//g, '\\')) && !existsSync(CLIP)) throw new Error(`clip not found: ${CLIP}`)

// Single-instance hygiene: dev and packaged share the `shortz` userData lock —
// sweep BOTH image names or the packaged app exits instantly (documented quirk
// in NOTES-B).
for (const img of ['ShortZ.exe', 'electron.exe']) {
  spawn('taskkill', ['/F', '/IM', img, '/T'], { stdio: 'ignore' })
}
await new Promise((r) => setTimeout(r, 2000))

const proc = spawn(EXE, [`--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
let procLog = ''
proc.stdout.on('data', (d) => (procLog += d))
proc.stderr.on('data', (d) => (procLog += d))

async function findPage() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('packaged app never exposed a CDP page — did it crash?\n' + procLog.slice(-2000))
}

const page = await findPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
const network = []
const consoleErrors = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) rej(new Error(m.error.message))
    else res(m)
    return
  }
  if (m.method === 'Network.responseReceived' && m.params.response.url.startsWith('media://')) {
    network.push({ status: m.params.response.status, cr: m.params.response.headers['content-range'] ?? null })
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(`EXCEPTION: ${m.params.exceptionDetails.text}`)
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
}
await new Promise((r) => (ws.onopen = r))
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
  }
  return r.result.result.value
}
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })

const failures = []
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!cond) failures.push(name)
}

// 1. window + Home render in the packaged build
const home = await evaluate(`({
  dropzone: !!document.querySelector('.dropzone'),
  home: !!document.querySelector('.home'),
  title: document.title
})`)
check('packaged: Home renders', home.home && home.dropzone, home.title)

// 2. security posture holds in production
const sec = await evaluate(`({
  nodeProcess: typeof process,
  nodeRequire: typeof require,
  bridge: typeof window.shortz === 'object' && typeof window.shortz.getMediaUrl === 'function',
  globals: Object.keys(window).filter(k => ['__dirname', 'global', 'Buffer'].includes(k))
})`)
check('packaged: no nodeIntegration leak', sec.nodeProcess === 'undefined' && sec.nodeRequire === 'undefined' && sec.globals.length === 0, JSON.stringify(sec))
check('packaged: preload bridge exposed', sec.bridge)

// 3. media:// works in PRODUCTION (getMediaUrl → 206s → video plays + seeks)
const url = await evaluate(`window.shortz.getMediaUrl(${JSON.stringify(CLIP)})`)
check('packaged: getMediaUrl mints media://', typeof url === 'string' && url.startsWith('media://'), url.slice(0, 60))

const play = await evaluate(`(async () => {
  const url = ${JSON.stringify(url)}
  const v = document.createElement('video')
  v.preload = 'auto'; v.muted = true
  await new Promise((res, rej) => {
    v.oncanplay = res
    v.onerror = () => rej(new Error('video error ' + (v.error ? v.error.code : '?')))
    setTimeout(() => rej(new Error('timeout')), 15000)
    v.src = url
  })
  const t0 = performance.now()
  await new Promise((res) => { v.onseeked = res; setTimeout(res, 6000); v.currentTime = Math.min(5, v.duration / 2) })
  return { duration: v.duration, w: v.videoWidth, h: v.videoHeight, seekMs: Math.round(performance.now() - t0) }
})()`)
check('packaged: video loads + seeks via media://', play.duration > 5 && play.seekMs < 2000, JSON.stringify(play))
check('packaged: 206 responses observed', network.length > 0 && network.every((n) => n.status === 206), JSON.stringify(network.slice(0, 3)))

// 4. Editor renders from a project card (missing source → honest relink banner)
const ed = await evaluate(`(async () => {
  const card = Array.from(document.querySelectorAll('.project-card')).find(c => !c.classList.contains('is-missing'))
  if (!card) return { skipped: true }
  card.click()
  await new Promise(r => setTimeout(r, 1500))
  return {
    skipped: false,
    editor: !!document.querySelector('.editor'),
    panes: [!!document.querySelector('.template-picker'), !!document.querySelector('.editor__preview-pane'), !!document.querySelector('.field-panel')],
    relink: !!document.querySelector('.relink-banner')
  }
})()`)
if (ed.skipped) {
  console.log('SKIP editor-from-card (no non-missing mock card present — e.g. real store landed)')
} else {
  check('packaged: Editor three panes render', ed.editor && ed.panes.every(Boolean))
  check('packaged: missing source surfaces relink banner', ed.relink)
}

const allow = (e) => e.includes('react-devtools') || e.includes('Download the React DevTools')
check('packaged: renderer console clean', consoleErrors.filter((e) => !allow(e)).length === 0, consoleErrors.filter((e) => !allow(e)).join(' | ').slice(0, 200))

ws.close()
spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
console.log('---')
if (failures.length > 0) {
  console.error('FAILURES:', failures)
  process.exit(1)
}
console.log('PACKAGED APP VERIFIED')
process.exit(0)
