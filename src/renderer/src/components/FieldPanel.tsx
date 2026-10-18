import { useCallback, useEffect, useState } from 'react'
import type { EditorConfig, EditorConfigMeta, Project } from '../../../preload/api'
import type { FieldDef, KnobDef, TextSlot } from '../../../shared/template/types'
import { fontKeyFor, wrapAndShrink, type FontLoader } from '../../../shared/layout/text'
import { formatTime } from '../lib/format'
import { toast } from '../stores/toastStore'
import { S } from '../strings'

/**
 * FieldPanel — right pane (ui-spec §editor): TEMPLATE SETTINGS = the
 * template's inputs[] (hook textarea with live line/char counters) then knobs
 * in declared order; CLIP = audio keep/mute, trim readouts (editable), reset.
 * Line metrics come from the shared opentype.js engine (same bytes + math as
 * the preview canvas and the render overlay).
 */

interface FieldPanelProps {
  project: Project
  knobs: KnobDef[]
  inputs: FieldDef[]
  textSlots: TextSlot[]
  loadFont: FontLoader
  duration: number
  onPatch: (mut: (draft: Project) => void) => void
}

export function FieldPanel({ project, knobs, inputs, textSlots, loadFont, duration, onPatch }: FieldPanelProps): JSX.Element {
  // {0,0} is the documented "no trim" value — trim is disabled until the user
  // actually types a range; it must never silently carry a clip's duration.
  const trimOff = project.trim.end <= project.trim.start
  // Named configurations: fixed folder, no dialogs (docs/technical/data-storage.md
  // §editor-configs). Save snapshots the editor under a name — saving with an
  // existing name updates it; Load applies the selected one here — a config
  // saved with trim off ({0,0}) keeps trim off, a tuned range is clamped to
  // the current clip so it cannot leak outside it.
  const [configs, setConfigs] = useState<EditorConfigMeta[]>([])
  const [configName, setConfigName] = useState('')
  const [selectedConfigId, setSelectedConfigId] = useState('')

  const refreshConfigs = useCallback(async (): Promise<EditorConfigMeta[]> => {
    try {
      const list = await window.shortz.listEditorConfigs()
      setConfigs(list)
      return list
    } catch (err) {
      toast.err(`${S.errLoadConfig}: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }, [])

  useEffect(() => {
    void refreshConfigs()
  }, [refreshConfigs])

  // Keep the selection valid as the list changes (save/delete).
  useEffect(() => {
    const first = configs[0]
    if (!first) {
      if (selectedConfigId !== '') setSelectedConfigId('')
    } else if (!configs.some((c) => c.id === selectedConfigId)) {
      setSelectedConfigId(first.id)
    }
  }, [configs, selectedConfigId])

  const saveConfig = async (): Promise<void> => {
    const name = configName.trim()
    if (name.length === 0) {
      toast.err(S.errConfigName)
      return
    }
    try {
      // Legacy projects carry an auto-filled {0, fullDuration} range — a range
      // that covers the whole clip is "never tuned" and saves as disabled, so
      // it can never cut a different (longer) video short later.
      const fullClip =
        project.trim.start === 0 && duration > 0 && project.trim.end >= duration - 0.05
      const meta = await window.shortz.saveEditorConfig({
        schemaVersion: 1,
        name,
        templateId: project.templateId,
        values: {
          fields: { ...project.values.fields },
          knobs: { ...project.values.knobs }
        },
        trim: trimOff || fullClip ? { start: 0, end: 0 } : { ...project.trim },
        audio: project.audio
      })
      setConfigName(meta.name)
      setSelectedConfigId(meta.id)
      await refreshConfigs()
      toast.ok(S.configSavedToast(meta.name))
    } catch (err) {
      toast.err(`${S.errSaveConfig}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const loadConfig = async (): Promise<void> => {
    if (!selectedConfigId) return
    let saved: EditorConfig
    try {
      saved = await window.shortz.loadEditorConfig(selectedConfigId)
    } catch (err) {
      toast.err(`${S.errLoadConfig}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    onPatch((d) => {
      d.templateId = saved.templateId
      d.values = {
        fields: { ...saved.values.fields },
        knobs: { ...saved.values.knobs }
      }
      const maxT = duration > 0 ? duration : saved.trim.end
      // {0,0} — trim was disabled when the config was saved; keep it disabled
      // instead of importing a range tied to a different clip.
      d.trim =
        saved.trim.end <= saved.trim.start
          ? { start: 0, end: 0 }
          : {
              start: Math.max(0, Math.min(saved.trim.start, Math.max(0, maxT - 0.1))),
              end: Math.max(0.1, Math.min(saved.trim.end, maxT))
            }
      d.audio = saved.audio
    })
    toast.ok(S.configLoadedToast(saved.name))
  }

  const deleteConfig = async (): Promise<void> => {
    const target = configs.find((c) => c.id === selectedConfigId)
    if (!target) return
    if (!window.confirm(S.configDeleteConfirm(target.name))) return
    try {
      await window.shortz.deleteEditorConfig(target.id)
      await refreshConfigs()
      if (configName.trim() === target.name) setConfigName('')
      toast.ok(S.configDeletedToast(target.name))
    } catch (err) {
      toast.err(`${S.errDeleteConfig}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="field-panel">
      <h2 className="pane-title">{S.templateSettingsTitle}</h2>

      {inputs.map((input) => {
        const value = project.values.fields[input.key] ?? ''
        const hookSlot = textSlots.find((s) => s.bindsTo === input.key) ?? textSlots[0]
        if (!hookSlot) return null
        const text = value.trim()
        const fitted =
          text.length > 0
            ? wrapAndShrink({
                loader: loadFont,
                fontKey: fontKeyFor(hookSlot.fontFamily, hookSlot.fontWeight),
                text,
                maxWidth: hookSlot.width,
                fontSize: hookSlot.fontSize,
                fontSizeMin: hookSlot.fontSizeMin,
                maxLines: hookSlot.maxLines,
                wordBreak: hookSlot.wordBreak
              })
            : null
        const tooLong = text.length > 0 && fitted === null
        const lineCount = fitted?.lines.length ?? (tooLong ? hookSlot.maxLines + 1 : 0)
        const hitFloor = fitted?.shrunkToFloor === true
        return (
          <div key={input.key} className="field">
            <label className="field__label" htmlFor={`field-${input.key}`}>
              {input.label}
              {input.required && <span className="field__req" aria-hidden> *</span>}
            </label>
            <textarea
              id={`field-${input.key}`}
              className={`input field__textarea${tooLong ? ' is-invalid' : ''}`}
              value={value}
              placeholder={input.placeholder}
              maxLength={input.maxLength}
              rows={4}
              onChange={(e) =>
                onPatch((d) => {
                  d.values.fields[input.key] = e.target.value
                })
              }
            />
            <div className={`field__counters${tooLong ? ' is-invalid' : ''}`}>
              {fitted ? (
                <span className={lineCount > hookSlot.maxLines ? 'is-invalid' : ''}>
                  {S.linesCount(lineCount, hookSlot.maxLines)}
                </span>
              ) : null}
              {input.maxLength ? <span>{S.charsCount(value.length, input.maxLength)}</span> : null}
            </div>
            {tooLong && (
              <div className="field__hint field__hint--err">
                {S.textTooLong(hookSlot.maxLines, hookSlot.fontSizeMin)}
              </div>
            )}
            {hitFloor && !tooLong && (
              <div className="field__hint">{S.textShrunk(hookSlot.fontSizeMin)}</div>
            )}
            {text.length === 0 && input.required && (
              <div className="field__hint">{S.inputRequired}</div>
            )}
          </div>
        )
      })}

      {knobs.map((knob) => {
        const current = project.values.knobs[knob.id] ?? knob.default
        return (
          <div key={knob.id} className="field field--knob">
            <label className="field__label" htmlFor={`knob-${knob.id}`}>
              {knob.label}
            </label>
            {knob.control === 'slider' && (
              <div className="knob-row">
                <input
                  id={`knob-${knob.id}`}
                  className="knob-row__slider"
                  type="range"
                  min={knob.min}
                  max={knob.max}
                  step={knob.step ?? 1}
                  value={Number(current)}
                  onChange={(e) =>
                    onPatch((d) => {
                      d.values.knobs[knob.id] = Number(e.target.value)
                    })
                  }
                />
                <span className="knob-row__value">{Number(current)}</span>
              </div>
            )}
            {knob.control === 'select' && (
              <select
                id={`knob-${knob.id}`}
                className="input knob-row__select"
                value={String(current)}
                onChange={(e) => {
                  const opt = knob.options?.find((o) => String(o.value) === e.target.value)
                  onPatch((d) => {
                    d.values.knobs[knob.id] = opt ? opt.value : e.target.value
                  })
                }}
              >
                {knob.options?.map((o) => (
                  <option key={String(o.value)} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        )
      })}

      <div className="field-panel__divider" role="presentation" />
      <h2 className="pane-title">{S.clipTitle}</h2>

      <div className="field field--audio" role="radiogroup" aria-label="Audio">
        <span className="field__label">Audio</span>
        <label className="radio">
          <input
            type="radio"
            name="audio"
            checked={project.audio === 'keep'}
            onChange={() =>
              onPatch((d) => {
                d.audio = 'keep'
              })
            }
          />
          {S.audioKeep}
        </label>
        <label className="radio">
          <input
            type="radio"
            name="audio"
            checked={project.audio === 'mute'}
            onChange={() =>
              onPatch((d) => {
                d.audio = 'mute'
              })
            }
          />
          {S.audioMute}
        </label>
      </div>

      <div className="field field--trim">
        <label className="field__label" htmlFor="trim-start">
          {S.trimStart}
        </label>
        <input
          id="trim-start"
          className="input field__number"
          type="number"
          min={0}
          max={trimOff ? Math.max(0.1, duration - 0.1) : project.trim.end - 0.1}
          step={0.1}
          value={trimOff ? '' : project.trim.start}
          placeholder={trimOff ? S.trimOff : undefined}
          onChange={(e) =>
            onPatch((d) => {
              if (e.target.value === '') {
                d.trim = { start: 0, end: 0 } // cleared → disabled
                return
              }
              if (trimOff) {
                if (duration <= 0) return // enabling needs the clip duration
                // First touch activates trim against the full clip.
                d.trim = {
                  start: Math.round(Math.max(0, Math.min(Number(e.target.value) || 0, duration - 0.1)) * 10) / 10,
                  end: Math.round(duration * 10) / 10
                }
                return
              }
              d.trim.start = Math.max(0, Math.min(Number(e.target.value) || 0, d.trim.end - 0.1))
            })
          }
        />
        <label className="field__label" htmlFor="trim-end">
          {S.trimEnd}
        </label>
        <input
          id="trim-end"
          className="input field__number"
          type="number"
          min={trimOff ? 0.1 : project.trim.start + 0.1}
          max={Math.max(0.1, duration)}
          step={0.1}
          value={trimOff ? '' : project.trim.end}
          placeholder={trimOff ? S.trimOff : undefined}
          onChange={(e) =>
            onPatch((d) => {
              if (e.target.value === '') {
                d.trim = { start: 0, end: 0 } // cleared → disabled
                return
              }
              const v = Number(e.target.value) || 0
              if (trimOff) {
                // First touch activates trim from 0 up to the typed end.
                d.trim = {
                  start: 0,
                  end: Math.round(Math.max(0.1, Math.min(v, duration > 0 ? duration : v)) * 10) / 10
                }
                return
              }
              d.trim.end = Math.max(d.trim.start + 0.1, Math.min(v, duration || d.trim.end))
            })
          }
        />
        <div className="field__hint">
          {formatTime(trimOff ? duration : Math.max(0, project.trim.end - project.trim.start))} kept
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            onPatch((d) => {
              d.trim = { start: 0, end: 0 }
            })
          }
        >
          {S.resetTrim}
        </button>
      </div>

      <div className="field-panel__divider" role="presentation" />
      <h2 className="pane-title">{S.configTitle}</h2>

      <div className="field field--config">
        <label className="field__label" htmlFor="config-name">
          {S.configNameLabel}
        </label>
        <input
          id="config-name"
          className="input"
          type="text"
          value={configName}
          placeholder={S.configNamePlaceholder}
          maxLength={60}
          onChange={(e) => setConfigName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void saveConfig()
            }
          }}
        />
        <div className="config-row">
          <button
            type="button"
            className="btn btn-sm"
            title={S.saveConfigTitle(configName)}
            onClick={() => void saveConfig()}
          >
            💾 {S.saveConfig}
          </button>
        </div>

        {configs.length > 0 && (
          <>
            <label className="field__label" htmlFor="config-pick">
              {S.configPickLabel}
            </label>
            <select
              id="config-pick"
              className="input"
              value={selectedConfigId}
              onChange={(e) => {
                setSelectedConfigId(e.target.value)
                // Picking a config seeds the name field, so Save updates it.
                const picked = configs.find((c) => c.id === e.target.value)
                if (picked) setConfigName(picked.name)
              }}
            >
              {configs.map((c) => (
                <option key={c.id} value={c.id}>
                  {configOptionLabel(c)}
                </option>
              ))}
            </select>
            <div className="config-row">
              <button
                type="button"
                className="btn btn-sm"
                title={S.loadConfigTitle}
                onClick={() => void loadConfig()}
              >
                📂 {S.loadConfig}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title={S.deleteConfigTitle}
                onClick={() => void deleteConfig()}
              >
                🗑 {S.deleteConfig}
              </button>
            </div>
          </>
        )}
        <div className="field__hint">{S.configHint}</div>
      </div>
    </div>
  )
}

function configOptionLabel(c: EditorConfigMeta): string {
  const when = new Date(c.savedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  return `${c.name} — ${when}`
}
