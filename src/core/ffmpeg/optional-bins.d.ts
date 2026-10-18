/**
 * Optional bundled-binary fallbacks. These packages are intentionally optional
 * (system FFmpeg on PATH is preferred); dynamic import failures are handled in
 * resolve-bin.ts. Minimal ambient types keep the core tier compiling without them.
 */
declare module 'ffmpeg-static' {
  const ffmpegPath: string | null
  export default ffmpegPath
}

declare module 'ffprobe-static' {
  const info: { path: string; version?: string }
  export default info
}
