/**
 * SafeZoneOverlay — translucent SVG of TikTok's UI chrome at true safe-zone
 * geometry (docs/technical/export-spec.md §safe zones; docs/03-tech-stack.md
 * "Decided at planning time" #3: SVG drawn in-app). Purely visual — never
 * rendered into the export.
 *
 * Rects (1080×1920 design space): top bar 0,0,1080,150 · right rail
 * 940,0,140,1920 · bottom caption 0,1500,1080,420.
 */

interface SafeZoneOverlayProps {
  /** Template-declared insets; used to outline the content-safe rect. */
  safeZones: { top: number; right: number; bottom: number; left: number }
}

export function SafeZoneOverlay({ safeZones }: SafeZoneOverlayProps): JSX.Element {
  return (
    <svg
      className="safe-zone-overlay"
      viewBox="0 0 1080 1920"
      width={1080}
      height={1920}
      aria-hidden
      focusable="false"
    >
      {/* danger zones */}
      <rect x="0" y="0" width="1080" height="150" className="sz-fill" />
      <rect x="940" y="0" width="140" height="1920" className="sz-fill" />
      <rect x="0" y="1500" width="1080" height="420" className="sz-fill" />

      {/* content-safe rect (template insets) */}
      <rect
        x={safeZones.left}
        y={safeZones.top}
        width={1080 - safeZones.left - safeZones.right}
        height={1920 - safeZones.top - safeZones.bottom}
        className="sz-safe-rect"
      />

      {/* TikTok chrome sketch: search pill */}
      <rect x="290" y="52" width="500" height="72" rx="36" className="sz-chrome" />
      <circle cx="345" cy="88" r="16" className="sz-chrome-stroke" />
      <line x1="370" y1="88" x2="560" y2="88" className="sz-chrome-line" />

      {/* right action rail: like / comment / share / bookmark / avatar / disc */}
      <circle cx="1010" cy="480" r="44" className="sz-chrome-fill" />
      <path d="M1010 460 l14 22 h-28 z" className="sz-chrome-fill2" />
      <circle cx="1010" cy="640" r="44" className="sz-chrome-fill" />
      <circle cx="1010" cy="800" r="44" className="sz-chrome-fill" />
      <circle cx="1010" cy="960" r="44" className="sz-chrome-fill" />
      <circle cx="1010" cy="1130" r="48" className="sz-chrome-fill" />
      <circle cx="1010" cy="1290" r="44" className="sz-chrome-stroke" />

      {/* bottom caption: username + caption lines + sound ticker */}
      <rect x="48" y="1556" width="380" height="34" rx="17" className="sz-chrome-fill" />
      <rect x="48" y="1620" width="640" height="30" rx="15" className="sz-chrome-fill" />
      <rect x="48" y="1672" width="520" height="30" rx="15" className="sz-chrome-fill" />
      <rect x="48" y="1740" width="300" height="26" rx="13" className="sz-chrome-fill" />
      <path d="M66 1753 h240 M116 1734 v38 M206 1741 l0 24 M246 1745 a12 12 0 1 0 0.1 0" className="sz-chrome-line" />
    </svg>
  )
}
