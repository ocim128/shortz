import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TemplateMeta } from '../../../../preload/api'
import { LayoutError, resolveLayout, type ResolvedLayout } from '../../../../shared/layout/engine'
import type { Slot, TextSlot } from '../../../../shared/template/types'
import { ExportBar } from '../../components/ExportBar'
import { FieldPanel } from '../../components/FieldPanel'
import { PhonePreview } from '../../components/PhonePreview'
import { PlaybackBar } from '../../components/PlaybackBar'
import { RelinkBanner } from '../../components/RelinkBanner'
import { TemplatePicker } from '../../components/TemplatePicker'
import { TrimRange } from '../../components/TrimRange'
import { clamp, formatTime, snapTenths } from '../../lib/format'
import { fontsReady, getFontLoader, loadBundledFonts } from '../../preview/font-loader'
import { usePlayerStore } from '../../stores/playerStore'
import { useProjectStore } from '../../stores/projectStore'
import { useRenderStore } from '../../stores/renderStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { toast } from '../../stores/toastStore'
import { S } from '../../strings'

/**
 * EditorScreen — the product (ui-spec §screen 2): template picker / phone
 * preview / field panel, top bar with probe chips + Export, conditional render
 * bar. The preview runs the SHARED layout engine (same files the render
 * pipeline uses, same bundled fonts over getFontBuffer). Keyboard: Space, I/O,
 * Ctrl+E (export), Esc, Ctrl+S, ←/→ (shift = 1s).
 */

type LayoutOutcome =
  | { kind: 'unavailable'; reason: 'no-clip-dims' }
  | { kind: 'ok'; layout: ResolvedLayout }
  | { kind: 'error'; error: LayoutError }

export function EditorScreen(): JSX.Element {
  const project = useProjectStore((s) => s.active)
  const patchActive = useProjectStore((s) => s.patchActive)
  const closeActive = useProjectStore((s) => s.closeActive)
  const forceSave = useProjectStore((s) => s.forceSave)
  const dirty = useProjectStore((s) => s.dirty)
  const settings = useSettingsStore((s) => s.settings)

  const duration = usePlayerStore((s) => s.duration)
  const videoWidth = usePlayerStore((s) => s.videoWidth)
  const videoHeight = usePlayerStore((s) => s.videoHeight)
  const setMedia = usePlayerStore((s) => s.setMedia)

  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [sourceMissing, setSourceMissing] = useState(false)
  const [showSafeZones, setShowSafeZones] = useState<boolean>(settings?.ui.safeZonesDefault ?? true)
  const [fontsLoaded, setFontsLoaded] = useState(fontsReady())
  const [templates, setTemplates] = useState<TemplateMeta[] | null>(null)

  // Settings load async — adopt the persisted default until the user toggles.
  useEffect(() => {
    if (settings) setShowSafeZones(settings.ui.safeZonesDefault)
  }, [settings?.ui.safeZonesDefault])

  // Fonts feed both CSS (preview canvas) and the shared opentype metrics.
  useEffect(() => {
    if (fontsLoaded) return
    void loadBundledFonts().then(
      () => setFontsLoaded(true),
      (err: unknown) => toast.err(`Fonts failed to load: ${err instanceof Error ? err.message : String(err)}`)
    )
  }, [fontsLoaded])

  // Template registry (built-in resources/templates + user templates).
  useEffect(() => {
    void window.shortz
      .listTemplates()
      .then(setTemplates)
      .catch((err: unknown) => {
        console.warn('[shortz] listTemplates failed:', err)
        setTemplates([])
      })
  }, [])

  // Resolve the media:// URL for the source (main validates + mints).
  useEffect(() => {
    if (!project) return
    let alive = true
    setMediaUrl(null)
    setSourceMissing(false)
    setMedia(null)
    window.shortz
      .getMediaUrl(project.source.path)
      .then((url) => {
        if (alive) setMediaUrl(url)
      })
      .catch((err: unknown) => {
        if (alive) {
          setSourceMissing(true)
          console.warn('[shortz] media url failed:', err)
        }
      })
    return () => {
      alive = false
    }
  }, [project?.source.path, project?.id, setMedia])

  const byId = useMemo(
    () => (project ? templates?.find((t) => t.id === project.templateId) : undefined),
    [project?.templateId, templates]
  )
  const firstValid = useMemo(() => templates?.find((t) => t.valid && t.body), [templates])
  const activeTemplate = byId ?? firstValid ?? null
  const activeInvalid = byId !== undefined && !byId.valid

  const layoutOutcome: LayoutOutcome | null = useMemo(() => {
    if (!project) return null
    if (!fontsLoaded || !activeTemplate || activeInvalid) return null
    // Clip dims: the import-time probe has display (rotation-normalized) dims —
    // prefer them; fall back to the <video> element's intrinsic size.
    const probe = project.source.probe
    const clip =
      probe && probe.width > 0 && probe.height > 0
        ? { width: probe.width, height: probe.height }
        : videoWidth > 0 && videoHeight > 0
          ? { width: videoWidth, height: videoHeight }
          : null
    if (!clip) return { kind: 'unavailable', reason: 'no-clip-dims' }
    try {
      return {
        kind: 'ok',
        layout: resolveLayout({
          template: activeTemplate.body!,
          // LayoutError import keeps the narrow class for catch-mapping below.
          values: project.values,
          clip,
          loadFont: getFontLoader()
        })
      }
    } catch (err) {
      const error =
        err instanceof LayoutError
          ? err
          : new LayoutError('invalid-template', err instanceof Error ? err.message : String(err))
      return { kind: 'error', error }
    }
  }, [project, project?.values, activeTemplate, activeInvalid, fontsLoaded, videoWidth, videoHeight])

  const layout = layoutOutcome?.kind === 'ok' ? layoutOutcome.layout : null
  const hookTooLong = layoutOutcome?.kind === 'error' && layoutOutcome.error.code === 'text-too-long'

  const canExport =
    project !== null &&
    project.source.missing !== true &&
    !activeInvalid &&
    layout !== null &&
    mediaUrl !== null

  const exportDisabledTitle = !canExport
    ? project?.source.missing === true
      ? S.exportDisabledMissing
      : hookTooLong
        ? S.exportDisabledTooLong
        : layout === null
          ? mediaUrl === null
            ? S.exportDisabledNoVideo
            : S.exportDisabledEmptyHook
          : S.exportHint
    : S.exportHint

  const relink = useCallback(async () => {
    if (!project) return
    const picked = await window.shortz.pickFile()
    if (!picked) return
    try {
      const updated = await window.shortz.relinkSource(project.id, picked)
      useProjectStore.setState({ active: updated })
      toast.ok(S.homeRelinked)
    } catch (err) {
      toast.err(`${S.errRelink}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [project?.id])

  // Keyboard shortcuts (ui-spec §interactions & shortcuts).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName ?? ''
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void forceSave().then(() => toast.ok(S.savedToast))
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        e.stopPropagation()
        void useRenderStore.getState().runJob()
        return
      }
      if (typing || tag === 'BUTTON') return

      const player = usePlayerStore.getState()
      const proj = useProjectStore.getState().active
      if (e.key === ' ') {
        e.preventDefault()
        player.toggle()
      } else if (e.key.toLowerCase() === 'i' || e.key.toLowerCase() === 'o') {
        if (!proj || duration <= 0) return
        const t = snapTenths(clamp(player.current, 0, duration))
        useProjectStore.getState().patchActive((d) => {
          if (e.key.toLowerCase() === 'i') d.trim.start = clamp(t, 0, d.trim.end - 0.1)
          else d.trim.end = clamp(t, d.trim.start + 0.1, duration)
        })
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const step = e.shiftKey ? 1 : 1 / 30
        player.seek(player.current + (e.key === 'ArrowRight' ? step : -step))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [duration, forceSave])

  if (!project) return <div className="editor editor--empty" />

  const probe = project.source.probe
  const chips: string[] = [project.name]
  const w = probe?.width || (videoWidth > 0 ? videoWidth : 0)
  const h = probe?.height || (videoHeight > 0 ? videoHeight : 0)
  if (w && h) chips.push(`${w}×${h}`)
  if (probe?.fps) chips.push(`${probe.fps}fps`)
  const dur = probe?.duration || duration
  if (dur > 0) chips.push(formatTime(dur))
  if (dirty) chips.push('●')

  return (
    <div className="editor">
      <header className="editor__topbar">
        <button type="button" className="btn btn-ghost" onClick={closeActive} title={`${S.back} (autosaves)`}>
          ← {S.back}
        </button>
        <div className="editor__chips">
          {chips.map((c, i) => (
            <span key={i} className={`chip${i === 0 ? ' chip--name' : ''}${c === '●' ? ' chip--dirty' : ''}`}>
              {c}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canExport}
          title={exportDisabledTitle}
          onClick={() => void useRenderStore.getState().runJob()}
        >
          {S.export} ▶
        </button>
      </header>

      {sourceMissing && <RelinkBanner onChoose={() => void relink()} />}

      <div className="editor__panes">
        {templates === null ? (
          <div className="template-picker" aria-busy></div>
        ) : (
          <TemplatePicker
            templates={templates}
            activeId={activeTemplate?.id ?? null}
            onSelect={(t) =>
              patchActive((d) => {
                d.templateId = t.id
              })
            }
          />
        )}

        <section className="editor__preview-pane">
          <div className="preview-toolbar">
            <button
              type="button"
              className={`btn btn-sm btn-toggle${showSafeZones ? ' is-on' : ''}`}
              onClick={() => setShowSafeZones((v) => !v)}
              aria-pressed={showSafeZones}
              title={S.safeZones}
            >
              ◉ {S.safeZones}
            </button>
          </div>
          {activeInvalid ? (
            <div className="layout-warnings">
              <div className="layout-warnings__item">
                ⚠ {S.invalidTemplate}: {byId?.error ?? 'unknown error'}
              </div>
            </div>
          ) : layoutOutcome?.kind === 'error' && !hookTooLong ? (
            <div className="layout-warnings">
              <div className="layout-warnings__item">
                ⚠ {S.layoutErrorTitle}: {layoutOutcome.error.message}
              </div>
            </div>
          ) : layout === null ? (
            <div className="layout-warnings">
              <div className="layout-warnings__item">…</div>
            </div>
          ) : (
            <PhonePreview
              layout={layout}
              mediaUrl={mediaUrl}
              muted={project.audio === 'mute'}
              showSafeZones={showSafeZones}
              safeZones={activeTemplate!.body!.safeZones}
            />
          )}
          <PlaybackBar />
          <TrimRange
            duration={duration}
            trim={project.trim}
            onChange={(trim) =>
              patchActive((d) => {
                d.trim = trim
              })
            }
          />
          {layout !== null && layout.warnings.length > 0 && (
            <div className="layout-warnings">
              {layout.warnings.map((w, i) => (
                <div key={i} className="layout-warnings__item">
                  ⚠ {w}
                </div>
              ))}
            </div>
          )}
        </section>

        <FieldPanel
          project={project}
          knobs={activeTemplate?.body?.knobs ?? []}
          inputs={activeTemplate?.body?.inputs ?? []}
          textSlots={(activeTemplate?.body?.slots.filter((s: Slot): s is TextSlot => s.type === 'text') ?? []) as TextSlot[]}
          loadFont={getFontLoader()}
          duration={duration}
          onPatch={patchActive}
        />
      </div>

      <ExportBar />
    </div>
  )
}
