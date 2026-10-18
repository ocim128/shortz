/**
 * Video extensions the app accepts — the ONE list feeding every import path:
 * the pickFile dialog filter, the media:// protocol, and the batch line
 * parser. Keeping them in one place is what keeps "batch accepts it,
 * preview refuses it" drift from coming back.
 */
export const VIDEO_EXTENSIONS = [
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'mpg',
  'mpeg',
  'ts'
] as const

export type VideoExtension = (typeof VIDEO_EXTENSIONS)[number]

export function isVideoExtension(ext: string): ext is VideoExtension {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}
