import type { ResolvedLayout } from '../preview/layout'
import { cssFontFamily } from '../preview/text'

/**
 * TextLayer — absolutely-positioned per-line spans styled from the resolved
 * layout. The browser never re-wraps (`white-space: pre`, `display: block`);
 * lines are pre-broken by the (placeholder) shared metrics
 * (docs/technical/template-schema.md §resolution contract).
 */
export function TextLayer({ layout }: { layout: ResolvedLayout }): JSX.Element {
  return (
    <>
      {layout.texts.map((t) => (
        <div
          key={t.slotId}
          className="text-layer"
          style={{
            left: t.x,
            top: t.y,
            width: t.width,
            textAlign: t.slot.align,
            color: t.slot.color,
            fontFamily: cssFontFamily(t.slot.fontFamily),
            fontWeight: t.slot.fontWeight,
            fontSize: t.fitted.fontSize,
            lineHeight: `${t.lineHeightPx}px`
          }}
        >
          {t.fitted.lines.map((line, i) => (
            <span key={i} className="text-layer__line">
              {line}
            </span>
          ))}
        </div>
      ))}
    </>
  )
}
