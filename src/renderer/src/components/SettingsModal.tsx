import { useEffect, useState } from 'react'
import type { Settings } from '../../../preload/api'
import { useSettingsStore } from '../stores/settingsStore'
import { toast } from '../stores/toastStore'
import { S } from '../strings'

/**
 * SettingsModal — screen 3 (ui-spec): Output / Encoder / FFmpeg / Storage /
 * About. Fields mirror settings.json (docs/technical/data-storage.md). FFmpeg
 * version/test and probe-cache size hit the real binaries via main.
 */

interface FfmpegDisplay {
  source: string
  version: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const load = useSettingsStore((s) => s.load)
  const save = useSettingsStore((s) => s.save)
  const [draft, setDraft] = useState<Settings | null>(settings)
  const [ffmpeg, setFfmpeg] = useState<FfmpegDisplay | null>(null)
  const [cache, setCache] = useState<{ entries: number; sizeLabel: string } | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!settings) void load()
    else setDraft(settings)
  }, [settings, load])

  useEffect(() => {
    let alive = true
    void window.shortz
      .ffmpegInfo()
      .then((info) => {
        if (alive) setFfmpeg({ source: info.source, version: info.version ?? 'unknown' })
      })
      .catch(() => undefined)
    void window.shortz
      .probeCacheInfo()
      .then((c) => {
        if (alive) setCache({ entries: c.entries, sizeLabel: formatBytes(c.bytes) })
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

  const clearCache = async (): Promise<void> => {
    await window.shortz.probeCacheClear()
    toast.ok(S.storageCacheCleared)
    void window.shortz
      .probeCacheInfo()
      .then((c) => setCache({ entries: c.entries, sizeLabel: formatBytes(c.bytes) }))
      .catch(() => undefined)
  }

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
      const info = await window.shortz.ffmpegTest()
      if (info.ok && info.version) {
        toast.ok(S.ffmpegTestOk(info.version))
        setFfmpeg({ source: info.source, version: info.version })
      } else {
        toast.err(S.ffmpegTestFail)
      }
    } catch {
      toast.err(S.ffmpegTestFail)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal aria-label={S.settingsTitle} onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <h2>{S.settingsTitle}</h2>
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
              <option value="auto">Auto</option>
              <option value="libx264">libx264 (software)</option>
              <option value="h264_nvenc">NVENC (NVIDIA)</option>
              <option value="h264_amf">AMF (AMD)</option>
              <option value="h264_qsv">QSV (Intel)</option>
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
                <em>{ffmpeg ? `${S.ffmpegSourceName(ffmpeg.source)} · ${ffmpeg.version}` : '—'}</em>
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
            <div className="settings-row">
              <span className="field__label">
                {S.storageProbeCache}: <em>{cache ? S.storageCacheValue(cache.entries, cache.sizeLabel) : '—'}</em>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void clearCache()}>
                {S.storageClear}
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
