import type { ResolvedLayout, ResolvedVideo } from '../../../shared/layout/engine'

/** Re-exports of the SHARED layout engine's resolved shapes (single engine, both tiers). */
export type SharedResolvedLayout = ResolvedLayout
export type SharedResolvedVideo = ResolvedVideo

/** Font families registered by preview/font-loader.ts (FontFace API). */
export type PreviewFamily = 'inter' | 'poppins'

export function previewFontFamily(family: PreviewFamily): string {
  return family === 'poppins'
    ? "'ShortZ Poppins', 'Poppins', system-ui, sans-serif"
    : "'ShortZ Inter', Inter, system-ui, sans-serif"
}

/** CSS font shorthand for canvas text (weights map through the loaded FontFaces). */
export function canvasFontFamilySpec(
  family: PreviewFamily,
  weight: number,
  fontSize: number
): string {
  return `${weight} ${fontSize}px ${previewFontFamily(family)}`
}

/** Phone frame on screen ≈ 390×693 (ui-spec §preview). */
export const PREVIEW_SCALE = 390 / 1080
