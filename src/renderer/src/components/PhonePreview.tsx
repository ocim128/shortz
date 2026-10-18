import type { BackgroundStyle } from '../../../preload/api'
import { PREVIEW_SCALE, type ResolvedLayout } from '../preview/layout'
import { SafeZoneOverlay } from './SafeZoneOverlay'
import { TextLayer } from './TextLayer'
import { VideoLayer } from './VideoLayer'

/**
 * PhonePreview — HTML/CSS composition inside a phone-shaped frame
 * (docs/02-architecture.md §Preview Compositor). The inner .design-root is the
 * full 1080×1920 design space scaled by 0.36 → 390×693 on screen; children
 * position in design px.
 */

const BG_COLOR: Record<BackgroundStyle, string> = {
  black: '#000000',
  white: '#ffffff',
  darkGray: '#0f0f0f',
  blurVideo: '#000000' // blurred video layer covers it when ready
}

interface PhonePreviewProps {
  layout: ResolvedLayout
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
          width: 1080,
          height: 1920,
          transform: `scale(${PREVIEW_SCALE})`,
          backgroundColor: BG_COLOR[layout.canvas.background]
        }}
      >
        <VideoLayer mediaUrl={mediaUrl} layout={layout} muted={muted} />
        <TextLayer layout={layout} />
        {showSafeZones && <SafeZoneOverlay safeZones={safeZones} />}
      </div>
    </div>
  )
}
