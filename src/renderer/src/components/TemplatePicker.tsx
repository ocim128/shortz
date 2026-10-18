import type { TemplateMeta } from '../../../preload/api'
import { isVideoSlot, type Template } from '../../../shared/template/types'
import { Icon } from './Icon'
import { S } from '../strings'

/**
 * TemplatePicker — left pane (ui-spec §editor): cards with mini mockup + name,
 * built-in/user badges, invalid user templates greyed with ⚠ tooltip, and the
 * ＋ user card that opens the user-templates folder in Explorer.
 */

interface TemplatePickerProps {
  templates: TemplateMeta[]
  activeId: string | null
  onSelect: (t: TemplateMeta) => void
}

function videoSlotOf(body: Template): { y: number; height: number; cornerRadius: number } | null {
  const video = body.slots.find((s) => isVideoSlot(s))
  return video ?? null
}

function MiniMockup({ body }: { body: Template }): JSX.Element {
  // CSS-drawn thumbnail from the template's declared geometry (per-cent of 1920).
  const v = videoSlotOf(body)
  return (
    <div className={`mini-mockup bg-${body.canvas.backgroundStyle}`}>
      {v ? (
        <div
          className="mini-mockup__video"
          style={{
            top: `${(v.y / 1920) * 100}%`,
            height: `${(v.height / 1920) * 100}%`,
            borderRadius: Math.min(6, (v.cornerRadius / 1080) * 72)
          }}
        />
      ) : null}
      <div className="mini-mockup__text" style={{ top: `${Math.max(4, (((v?.y ?? 520) - 160) / 1920) * 100)}%` }}>
        <span />
        <span />
        <span style={{ width: '55%' }} />
      </div>
    </div>
  )
}

export function TemplatePicker({ templates, activeId, onSelect }: TemplatePickerProps): JSX.Element {
  const valid = templates.filter((t) => t.valid && t.body)
  const invalid = templates.filter((t) => !t.valid)
  return (
    <div className="template-picker">
      <h2 className="pane-title">{S.templatesTitle}</h2>
      <div className="template-picker__list">
        {valid.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`card template-card${t.id === activeId ? ' is-active' : ''}`}
            onClick={() => onSelect(t)}
            title={t.description}
          >
            <MiniMockup body={t.body as Template} />
            <div className="template-card__name">{t.name}</div>
            <span className={`badge ${t.badge === 'user' ? 'badge--user' : 'badge--builtin'}`}>
              {t.badge === 'user' ? S.badgeUser : S.badgeBuiltin}
            </span>
          </button>
        ))}
        {invalid.map((t) => (
          <div
            key={t.id}
            className="card template-card is-invalid"
            title={`${S.invalidTemplate}: ${t.error ?? 'unknown error'}`}
            aria-disabled
          >
            <div className="mini-mockup mini-mockup--invalid">
              <Icon name="alert" size={16} />
            </div>
            <div className="template-card__name">{t.name}</div>
            <span className="badge badge--user">{S.badgeUser}</span>
          </div>
        ))}
        <button
          type="button"
          className="card template-card template-card--add"
          onClick={() => void window.shortz.openUserTemplatesFolder()}
          title={S.addUserTemplateTitle}
        >
          <div className="mini-mockup mini-mockup--add">
            <Icon name="plus" size={16} />
          </div>
          <div className="template-card__name">{S.addUserTemplate}</div>
        </button>
      </div>
    </div>
  )
}
