import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExportBar } from '../../components/ExportBar'
import { FieldPanel } from '../../components/FieldPanel'
import { PhonePreview } from '../../components/PhonePreview'
import { PlaybackBar } from '../../components/PlaybackBar'
import { RelinkBanner } from '../../components/RelinkBanner'
import { TemplatePicker } from '../../components/TemplatePicker'
import { TrimRange } from '../../components/TrimRange'
import { clamp, formatTime, snapTenths } from '../../lib/format'
import { findMockTemplate, mockTemplates } from '../../mock/templates'
import { resolveLayout } from '../../preview/layout'
import { usePlayerStore } from '../../stores/playerStore'
import { useProjectStore } from '../../stores/projectStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { toast } from '../../stores/toastStore'
import { S } from '../../strings'

/**
 * EditorScreen — the product (ui-spec §screen 2): template picker / phone
 * preview / field panel, top bar with probe chips + Export, conditional
 * render bar. Keyboard: Space, I/O, Ctrl+E, Esc, Ctrl+S, ←/→ (shift = 1s).
 */
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

  // Settings load async — adopt the persisted default until the user toggles.
  useEffect(() => {
    if (settings) setShowSafeZones(settings.ui.safeZonesDefault)
  }, [settings?.ui.safeZonesDefault])

  const template = useMemo(
    () => (project ? (findMockTemplate(project.templateId) ?? mockTemplates[0]!) : mockTemplates[0]!),
    [project?.templateId]
  )

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

  const layout = useMemo(() => {
    if (!project) return null
    const clip = videoWidth > 0 && videoHeight > 0 ? { width: videoWidth, height: videoHeight } : null
    return resolveLayout(template.body, project.values, clip)
  }, [project, project?.values, template, videoWidth, videoHeight])

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
        toast.info(S.enginePendingToast)
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

  if (!project || !layout) return <div className="editor editor--empty" />

  const probe = project.source.probe
  const chips: string[] = [project.name]
  const w = probe?.width || (videoWidth > 0 ? videoWidth : 0)
  const h = probe?.height || (videoHeight > 0 ? videoHeight : 0)
  if (w && h) chips.push(`${w}×${h}`)
  if (probe?.fps) chips.push(`${probe.fps}fps`)
  const dur = probe?.duration || duration
  if (dur > 0) chips.push(formatTime(dur))

  return (
    <div className="editor">
      <header className="editor__topbar">
        <button type="button" className="btn btn-ghost" onClick={closeActive} title={`${S.back} (autosaves)`}>
          ← {S.back}
        </button>
        <div className="editor__chips">
          {chips.map((c, i) => (
            <span key={i} className={`chip${i === 0 ? ' chip--name' : ''}`}>
              {c}
            </span>
          ))}
          {dirty && (
            <span className="chip chip--dirty" title={S.unsavedDot}>
              ●
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled
          title={S.exportPendingTooltip}
          aria-disabled
        >
          {S.export} ▶
        </button>
      </header>

      {sourceMissing && <RelinkBanner onChoose={() => void relink()} />}

      <div className="editor__panes">
        <TemplatePicker
          templates={mockTemplates}
          activeId={project.templateId}
          onSelect={(t) =>
            patchActive((d) => {
              d.templateId = t.id
            })
          }
        />

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
          <PhonePreview
            layout={layout}
            mediaUrl={mediaUrl}
            muted={project.audio === 'mute'}
            showSafeZones={showSafeZones}
            safeZones={template.body.safeZones}
          />
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
          {layout.warnings.length > 0 && (
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
          knobs={template.body.knobs}
          inputs={template.body.inputs}
          textSlots={template.body.textSlots}
          duration={duration}
          onPatch={patchActive}
        />
      </div>

      <ExportBar />
    </div>
  )
}
