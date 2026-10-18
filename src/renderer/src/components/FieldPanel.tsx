import type { Project } from '../../../preload/api'
import type { FieldDef, KnobDef, TextSlot } from '../../../shared/template/types'
import { fontKeyFor, wrapAndShrink, type FontLoader } from '../../../shared/layout/text'
import { formatTime } from '../lib/format'
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
          max={project.trim.end - 0.1}
          step={0.1}
          value={project.trim.start}
          onChange={(e) =>
            onPatch((d) => {
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
          min={project.trim.start + 0.1}
          max={Math.max(0.1, duration)}
          step={0.1}
          value={project.trim.end}
          onChange={(e) =>
            onPatch((d) => {
              d.trim.end = Math.max(d.trim.start + 0.1, Math.min(Number(e.target.value) || 0, duration || d.trim.end))
            })
          }
        />
        <div className="field__hint">{formatTime(Math.max(0, project.trim.end - project.trim.start))} kept</div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            onPatch((d) => {
              d.trim = { start: 0, end: duration > 0 ? Math.round(duration * 10) / 10 : 0 }
            })
          }
        >
          {S.resetTrim}
        </button>
      </div>
    </div>
  )
}
