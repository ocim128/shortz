import type { BackgroundStyle } from '../../../shared/template/types'
import type { ResolvedLayout } from '../../../shared/layout/engine'
import { SafeZoneOverlay } from './SafeZoneOverlay'
import { TextLayer } from './TextLayer'
import { VideoLayer } from './VideoLayer'

/** Phone frame on screen ≈ 390×693 (ui-spec §preview). */
const PREVIEW_SCALE = 390 / 1080

/**
 * PhonePreview — HTML/CSS composition inside a phone-shaped frame
 * (docs/02-architecture.md §Preview Compositor). The inner .design-root is the
 * full 1080×1920 design space scaled by 0.36 → 390×693 on screen; children
 * position in design px. Text is painted on a canvas with the shared engine's
 * exact metrics; the video keeps native scaling.
 */

const BG_COLOR: Record<Exclude<BackgroundStyle, 'blurVideo'>, string> = {
  black: '#000000',
  white: '#ffffff',
  darkGray: '#0f0f0f'
}

/**
 * A preview-only marker for a required-but-empty text slot: a dashed box at
 * the geometry where the slot's first line will land once it is typed. Never
 * part of the export.
 */
export interface GhostSlot {
  x: number
  y: number
  width: number
  height: number
}

interface PhonePreviewProps {
  layout: ResolvedLayout
  mediaUrl: string | null
  muted: boolean
  showSafeZones: boolean
  safeZones: { top: number; right: number; bottom: number; left: number }
  ghostSlots?: GhostSlot[]
}

export function PhonePreview({
  layout,
  mediaUrl,
  muted,
  showSafeZones,
  safeZones,
  ghostSlots
}: PhonePreviewProps): JSX.Element {
  return (
    <div className="phone-frame">
      <div
        className="design-root"
        style={{
          width: layout.canvas.width,
          height: layout.canvas.height,
          transform: `scale(${PREVIEW_SCALE})`,
          backgroundColor:
            layout.canvas.background === 'blurVideo'
              ? '#000000' // the blurred video layer covers it
              : BG_COLOR[layout.canvas.background]
        }}
      >
        <VideoLayer mediaUrl={mediaUrl} layout={layout} muted={muted} />
        <TextLayer layout={layout} />
        {ghostSlots?.map((g, i) => (
          <div
            key={i}
            className="ghost-slot"
            style={{ left: g.x, top: g.y, width: g.width, height: g.height }}
          />
        ))}
        {showSafeZones && <SafeZoneOverlay safeZones={safeZones} />}
      </div>
    </div>
  )
}
