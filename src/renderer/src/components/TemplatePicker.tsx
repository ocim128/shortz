import type { MockTemplate } from '../mock/templates'
import { S } from '../strings'

/**
 * TemplatePicker — left pane (ui-spec §editor): cards with mini mockup + name,
 * built-in/user badges, invalid user templates greyed with ⚠ tooltip, and the
 * ＋ user card that opens the user-templates folder in Explorer.
 */

interface TemplatePickerProps {
  templates: MockTemplate[]
  activeId: string | null
  onSelect: (t: MockTemplate) => void
}

function MiniMockup({ template }: { template: MockTemplate }): JSX.Element {
  // CSS-drawn thumbnail from the template's declared geometry (per-cent of 1920).
  const v = template.body.videoSlot
  return (
    <div className={`mini-mockup bg-${template.body.canvas.backgroundStyle}`}>
      <div
        className="mini-mockup__video"
        style={{
          top: `${(v.y / 1920) * 100}%`,
          height: `${(v.height / 1920) * 100}%`,
          borderRadius: Math.min(6, (v.cornerRadius / 1080) * 72)
        }}
      />
      <div className="mini-mockup__text" style={{ top: `${Math.max(4, ((v.y - 160) / 1920) * 100)}%` }}>
        <span />
        <span />
        <span style={{ width: '55%' }} />
      </div>
    </div>
  )
}

export function TemplatePicker({ templates, activeId, onSelect }: TemplatePickerProps): JSX.Element {
  return (
    <div className="template-picker">
      <h2 className="pane-title">{S.templatesTitle}</h2>
      <div className="template-picker__list">
        {templates.map((t) =>
          t.valid ? (
            <button
              key={t.id}
              type="button"
              className={`card template-card${t.id === activeId ? ' is-active' : ''}`}
              onClick={() => onSelect(t)}
              title={t.description}
            >
              <MiniMockup template={t} />
              <div className="template-card__name">{t.name}</div>
              <span className={`badge ${t.badge === 'user' ? 'badge--user' : 'badge--builtin'}`}>
                {t.badge === 'user' ? S.badgeUser : S.badgeBuiltin}
              </span>
            </button>
          ) : (
            <div
              key={t.id}
              className="card template-card is-invalid"
              title={`${S.invalidTemplate}: ${t.error ?? 'unknown error'}`}
              aria-disabled
            >
              <div className="mini-mockup mini-mockup--invalid">⚠</div>
              <div className="template-card__name">{t.name}</div>
              <span className="badge badge--user">{S.badgeUser}</span>
            </div>
          )
        )}
        <button
          type="button"
          className="card template-card template-card--add"
          onClick={() => void window.shortz.openUserTemplatesFolder()}
          title={S.addUserTemplateTitle}
        >
          <div className="mini-mockup mini-mockup--add">＋</div>
          <div className="template-card__name">{S.addUserTemplate}</div>
        </button>
      </div>
    </div>
  )
}
