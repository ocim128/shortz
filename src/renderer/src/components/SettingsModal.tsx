import { useEffect, useRef, useState } from 'react'
import type { FfmpegInfo, Settings } from '../../../preload/api'
import { Icon } from './Icon'
import { useSettingsStore } from '../stores/settingsStore'
import { toast } from '../stores/toastStore'
import { S } from '../strings'

/**
 * SettingsModal — screen 3 (ui-spec): Output / Encoder / FFmpeg / Storage /
 * About. Fields mirror settings.json (docs/technical/data-storage.md). The
 * FFmpeg version row hits the real binary via main.
 */

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const load = useSettingsStore((s) => s.load)
  const save = useSettingsStore((s) => s.save)
  const [draft, setDraft] = useState<Settings | null>(settings)
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus the dialog on open (screen readers announce it) and keep Tab inside.
  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [href]')
      ).filter((el) => !(el as HTMLInputElement).disabled && el.offsetParent !== null)
      if (focusables.length === 0) return
      const first = focusables[0] as HTMLElement
      const last = focusables[focusables.length - 1] as HTMLElement
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!settings) void load()
    else setDraft(settings)
  }, [settings, load])

  useEffect(() => {
    let alive = true
    void window.shortz
      .ffmpegInfo()
      .then((info) => {
        if (alive) setFfmpeg(info)
      })
      .catch(() => undefined)
    void window.shortz
      .appVersion()
      .then((v) => {
        if (alive) setAppVersion(v)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  if (!draft) {
    return (
      <div className="modal-overlay" role="dialog" aria-modal>
        <div className="modal modal--loading">…</div>
      </div>
    )
  }

  const set = (mut: (d: Settings) => void): void => {
    setDraft((prev) => {
      const next: Settings = JSON.parse(JSON.stringify(prev))
      mut(next)
      return next
    })
  }

  const onSave = async (): Promise<void> => {
    await save(draft)
    toast.ok(S.settingsSaved)
    onClose()
  }

  const testFfmpeg = async (): Promise<void> => {
    try {
      const info = await window.shortz.ffmpegInfo()
      setFfmpeg(info)
      if (info.version) toast.ok(S.ffmpegTestOk(info.version))
      else toast.err(S.ffmpegTestFail)
    } catch {
      toast.err(S.ffmpegTestFail)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-label={S.settingsTitle}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2>{S.settingsTitle}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={S.settingsCancel} title={S.settingsCancel}>
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="modal__body">
          <section className="settings-section">
            <h3>{S.secOutput}</h3>
            <label className="field__label" htmlFor="set-outdir">
              {S.outputDir}
            </label>
            <input
              id="set-outdir"
              className="input"
              value={draft.output.dir}
              onChange={(e) => set((d) => (d.output.dir = e.target.value))}
            />
            <label className="field__label" htmlFor="set-pattern">
              {S.filenamePattern}
            </label>
            <input
              id="set-pattern"
              className="input"
              value={draft.output.filenamePattern}
              onChange={(e) => set((d) => (d.output.filenamePattern = e.target.value))}
            />
          </section>

          <section className="settings-section">
            <h3>{S.secEncoder}</h3>
            <label className="field__label" htmlFor="set-encoder">
              {S.encoderPreferred}
            </label>
            <select
              id="set-encoder"
              className="input"
              value={draft.encoder.preferred}
              onChange={(e) => set((d) => (d.encoder.preferred = e.target.value as Settings['encoder']['preferred']))}
            >
              <option value="auto">Auto (libx264)</option>
              <option value="libx264">libx264 (software)</option>
              <option value="h264_nvenc">NVENC (NVIDIA)</option>
            </select>
            <label className="field__label" htmlFor="set-crf">
              {S.encoderCrf}
            </label>
            <select
              id="set-crf"
              className="input"
              value={String(draft.encoder.crf)}
              onChange={(e) => set((d) => (d.encoder.crf = Number(e.target.value) as Settings['encoder']['crf']))}
            >
              <option value="17">17 (best)</option>
              <option value="18">18 (default)</option>
              <option value="20">20</option>
              <option value="23">23 (small)</option>
            </select>
            <label className="field__label" htmlFor="set-fps">
              {S.encoderFps}
            </label>
            <select
              id="set-fps"
              className="input"
              value={String(draft.encoder.fps)}
              onChange={(e) =>
                set((d) => (d.encoder.fps = e.target.value === 'source' ? 'source' : (Number(e.target.value) as 30 | 60)))
              }
            >
              <option value="30">30</option>
              <option value="60">60</option>
              <option value="source">Source</option>
            </select>
          </section>

          <section className="settings-section">
            <h3>{S.secFfmpeg}</h3>
            <label className="field__label" htmlFor="set-ffmpeg">
              {S.ffmpegSource}
            </label>
            <select
              id="set-ffmpeg"
              className="input"
              value={draft.ffmpeg.source}
              onChange={(e) => set((d) => (d.ffmpeg.source = e.target.value as Settings['ffmpeg']['source']))}
            >
              <option value="auto">Auto (system → bundled)</option>
              <option value="system">System PATH</option>
              <option value="bundled">Bundled</option>
            </select>
            <div className="settings-row">
              <span className="field__label">
                {S.ffmpegVersion}:{' '}
                <em>{ffmpeg ? `${S.ffmpegSourceName(ffmpeg.source)} · ${ffmpeg.version ?? 'unknown'}` : '—'}</em>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void testFfmpeg()}>
                {S.ffmpegTest}
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3>{S.secStorage}</h3>
            <div className="settings-row">
              <span className="field__label">{S.storageTemplates}</span>
              <button type="button" className="btn btn-sm" onClick={() => void window.shortz.openUserTemplatesFolder()}>
                {S.storageOpen}
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3>{S.secAbout}</h3>
            <p className="settings-about">{S.aboutVersion(appVersion ?? '…')}</p>
            <p className="settings-about">{S.aboutLicenses}</p>
          </section>
        </div>

        <footer className="modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {S.settingsCancel}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void onSave()}>
            {S.settingsSave}
          </button>
        </footer>
      </div>
    </div>
  )
}
