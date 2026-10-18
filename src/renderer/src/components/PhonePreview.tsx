import type { BackgroundStyle } from '../../../shared/template/types'
import { PREVIEW_SCALE, type SharedResolvedLayout } from '../preview/canvas-spec'
import { SafeZoneOverlay } from './SafeZoneOverlay'
import { TextLayer } from './TextLayer'
import { VideoLayer } from './VideoLayer'

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

interface PhonePreviewProps {
  layout: SharedResolvedLayout
  mediaUrl: string | null
  muted: boolean
  showSafeZones: boolean
  safeZones: { top: number; right: number; bottom: number; left: number }
}

export function PhonePreview({ layout, mediaUrl, muted, showSafeZones, safeZones }: PhonePreviewProps): JSX.Element {
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
        {showSafeZones && <SafeZoneOverlay safeZones={safeZones} />}
      </div>
    </div>
  )
}
