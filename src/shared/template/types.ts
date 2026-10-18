import type { KnobId } from './knob-registry'

export type BackgroundStyle = 'black' | 'white' | 'darkGray' | 'blurVideo'

export interface BlurSpec {
  sigma: number
  darken: number
}

export interface CanvasSpec {
  width: number
  height: number
  backgroundStyle: BackgroundStyle
  blur?: BlurSpec
}

export interface SafeZones {
  top: number
  right: number
  bottom: number
  left: number
}

export interface Template {
  schemaVersion: 1
  id: string
  name: string
  description: string
  thumbnail: string
  canvas: CanvasSpec
  safeZones: SafeZones
  slots: Slot[]
  knobs: KnobDef[]
  inputs: FieldDef[]
}

export type FieldControl = 'text' | 'textarea'

export interface FieldDef {
  key: string
  label: string
  control: FieldControl
  placeholder?: string
  maxLength?: number
  required?: boolean
}

export interface SlotBase {
  id: string
  x: number
  width: number
  visible: boolean
  tStart?: number
  tEnd?: number
}

export interface VideoSlot extends SlotBase {
  type: 'video'
  y: number
  height: number
  fit: 'contain' | 'cover'
  scale: number
  cornerRadius: number
  borderWidth: number
  borderColor: string
}

export type TextAnchor =
  | { kind: 'fixed'; y: number; height: number }
  | { kind: 'aboveVideo'; gap: number; minY: number }

export interface TextSlot extends SlotBase {
  type: 'text'
  bindsTo: string
  anchor: TextAnchor
  fontFamily: 'inter' | 'poppins'
  fontWeight: 400 | 600 | 800
  fontSize: number
  fontSizeMin: number
  lineHeight: number
  color: string
  align: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
  maxLines: number
  wordBreak: 'normal' | 'break-word'
}

/** Phase 2 slot types — parsed but not rendered in v1. */
export interface ImageSlot extends SlotBase {
  type: 'image'
  src: string
}

export interface ShapeSlot extends SlotBase {
  type: 'shape'
  shape: string
}

export type Slot = VideoSlot | TextSlot | ImageSlot | ShapeSlot

export type KnobControl = 'slider' | 'select' | 'toggle' | 'color'

export interface KnobDef {
  id: KnobId
  label: string
  default: unknown
  control: KnobControl
  min?: number
  max?: number
  step?: number
  options?: { value: unknown; label: string }[]
}

export function isVideoSlot(slot: Slot): slot is VideoSlot {
  return slot.type === 'video'
}

export function isTextSlot(slot: Slot): slot is TextSlot {
  return slot.type === 'text'
}
