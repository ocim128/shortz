import { KNOB_REGISTRY, isKnobId, validateKnobValue } from './knob-registry'
import type {
  BackgroundStyle,
  KnobDef,
  Slot,
  Template,
  TextAnchor,
  TextSlot,
  VideoSlot
} from './types'
import { isPlainObject as isRecord } from '../domain'

export interface ValidationIssue {
  path: string
  message: string
}

export type TemplateValidationResult =
  { ok: true; template: Template } | { ok: false; issues: ValidationIssue[] }

export class TemplateValidationError extends Error {
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super(
      `Template validation failed:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`
    )
    this.name = 'TemplateValidationError'
    this.issues = issues
  }
}

const BACKGROUND_STYLES: readonly BackgroundStyle[] = ['black', 'white', 'darkGray', 'blurVideo']
const HEX_COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function validateTemplate(raw: unknown): TemplateValidationResult {
  const issues: ValidationIssue[] = []
  const add = (path: string, message: string): void => {
    issues.push({ path, message })
  }

  if (!isRecord(raw)) {
    return { ok: false, issues: [{ path: '', message: 'template must be a JSON object' }] }
  }

  // Rule 1 — schemaVersion
  if (raw.schemaVersion !== 1) {
    add('schemaVersion', 'expected 1 (the only supported version)')
  }

  for (const key of ['id', 'name', 'description', 'thumbnail'] as const) {
    if (!isNonEmptyString(raw[key])) add(key, 'expected a non-empty string')
  }

  // Canvas
  const canvas = raw.canvas
  let canvasWidth = 1080
  let canvasHeight = 1920
  let backgroundStyle: BackgroundStyle = 'black'
  let blur: { sigma: number; darken: number } | undefined
  if (!isRecord(canvas)) {
    add('canvas', 'expected an object')
  } else {
    if (!isFiniteNumber(canvas.width) || canvas.width <= 0)
      add('canvas.width', 'expected a positive number')
    else canvasWidth = canvas.width
    if (!isFiniteNumber(canvas.height) || canvas.height <= 0)
      add('canvas.height', 'expected a positive number')
    else canvasHeight = canvas.height
    if (
      typeof canvas.backgroundStyle !== 'string' ||
      !BACKGROUND_STYLES.includes(canvas.backgroundStyle as BackgroundStyle)
    ) {
      add('canvas.backgroundStyle', `expected one of ${BACKGROUND_STYLES.join(', ')}`)
    } else {
      backgroundStyle = canvas.backgroundStyle as BackgroundStyle
    }
    if (canvas.blur !== undefined) {
      if (
        !isRecord(canvas.blur) ||
        !isFiniteNumber(canvas.blur.sigma) ||
        !isFiniteNumber(canvas.blur.darken)
      ) {
        add('canvas.blur', 'expected { sigma: number, darken: number }')
      } else {
        blur = { sigma: canvas.blur.sigma, darken: canvas.blur.darken }
      }
    }
  }

  // Safe zones
  const safeZones = { top: 150, right: 140, bottom: 420, left: 0 }
  if (!isRecord(raw.safeZones)) {
    add('safeZones', 'expected { top, right, bottom, left }')
  } else {
    for (const key of ['top', 'right', 'bottom', 'left'] as const) {
      const v = raw.safeZones[key]
      if (!isFiniteNumber(v) || v < 0) add(`safeZones.${key}`, 'expected a non-negative number')
      else safeZones[key] = v
    }
  }

  // Slots
  if (!Array.isArray(raw.slots) || raw.slots.length === 0) {
    add('slots', 'expected a non-empty array')
    return { ok: false, issues }
  }

  const slots: Slot[] = []
  const slotIds = new Set<string>()
  let videoSlots = 0

  raw.slots.forEach((entry, index) => {
    const path = `slots[${index}]`
    if (!isRecord(entry)) {
      add(path, 'expected an object')
      return
    }
    if (!isNonEmptyString(entry.id)) add(`${path}.id`, 'expected a non-empty string')
    else if (slotIds.has(entry.id)) add(`${path}.id`, `duplicate slot id "${entry.id}"`)
    else slotIds.add(entry.id)

    if (entry.visible !== undefined && typeof entry.visible !== 'boolean') {
      add(`${path}.visible`, 'expected a boolean')
    }

    const x = isFiniteNumber(entry.x) ? entry.x : NaN
    const width = isFiniteNumber(entry.width) ? entry.width : NaN
    if (!isFiniteNumber(entry.x) || entry.x < 0) add(`${path}.x`, 'expected a number >= 0')
    if (!isFiniteNumber(entry.width) || entry.width <= 0)
      add(`${path}.width`, 'expected a number > 0')
    if (isFiniteNumber(x) && isFiniteNumber(width) && x + width > canvasWidth) {
      add(`${path}.width`, `slot exceeds canvas width (${x + width} > ${canvasWidth})`)
    }

    switch (entry.type) {
      case 'video': {
        videoSlots += 1
        const slot = entry as unknown as VideoSlot
        if (!isFiniteNumber(slot.y) || slot.y < 0) add(`${path}.y`, 'expected a number >= 0')
        if (!isFiniteNumber(slot.height) || slot.height <= 0)
          add(`${path}.height`, 'expected a number > 0')
        if (
          isFiniteNumber(slot.y) &&
          isFiniteNumber(slot.height) &&
          slot.y + slot.height > canvasHeight
        ) {
          add(
            `${path}.height`,
            `slot exceeds canvas height (${slot.y + slot.height} > ${canvasHeight})`
          )
        }
        if (slot.fit !== 'contain' && slot.fit !== 'cover')
          add(`${path}.fit`, "expected 'contain' or 'cover'")
        if (!isFiniteNumber(slot.scale) || slot.scale <= 0 || slot.scale > 1) {
          add(`${path}.scale`, 'expected a number in (0, 1]')
        }
        if (!isFiniteNumber(slot.cornerRadius) || slot.cornerRadius < 0) {
          add(`${path}.cornerRadius`, 'expected a number >= 0')
        }
        if (!isFiniteNumber(slot.borderWidth) || slot.borderWidth < 0) {
          add(`${path}.borderWidth`, 'expected a number >= 0')
        }
        if (typeof slot.borderColor !== 'string' || !HEX_COLOR.test(slot.borderColor)) {
          add(`${path}.borderColor`, 'expected #RRGGBB or #RRGGBBAA')
        }
        slots.push(slot)
        break
      }
      case 'text': {
        const slot = entry as unknown as TextSlot
        if (!isNonEmptyString(slot.bindsTo)) add(`${path}.bindsTo`, 'expected a non-empty string')
        if (slot.fontFamily !== 'inter' && slot.fontFamily !== 'poppins') {
          add(`${path}.fontFamily`, "expected 'inter' or 'poppins'")
        }
        if (slot.fontWeight !== 400 && slot.fontWeight !== 600 && slot.fontWeight !== 800) {
          add(`${path}.fontWeight`, 'expected 400, 600 or 800')
        }
        if (!isFiniteNumber(slot.fontSize)) add(`${path}.fontSize`, 'expected a number')
        if (!isFiniteNumber(slot.fontSizeMin)) add(`${path}.fontSizeMin`, 'expected a number')
        if (isFiniteNumber(slot.fontSize) && isFiniteNumber(slot.fontSizeMin)) {
          if (slot.fontSizeMin < 12) add(`${path}.fontSizeMin`, 'expected >= 12')
          if (slot.fontSize < slot.fontSizeMin)
            add(`${path}.fontSize`, 'expected fontSize >= fontSizeMin')
        }
        if (!isFiniteNumber(slot.lineHeight) || slot.lineHeight < 1 || slot.lineHeight > 2) {
          add(`${path}.lineHeight`, 'expected a number in [1.0, 2.0]')
        }
        if (!isFiniteNumber(slot.maxLines) || slot.maxLines < 1)
          add(`${path}.maxLines`, 'expected >= 1')
        if (typeof slot.color !== 'string' || !HEX_COLOR.test(slot.color)) {
          add(`${path}.color`, 'expected #RRGGBB or #RRGGBBAA')
        }
        if (!['left', 'center', 'right'].includes(slot.align))
          add(`${path}.align`, 'expected left/center/right')
        if (!['top', 'middle', 'bottom'].includes(slot.vAlign))
          add(`${path}.vAlign`, 'expected top/middle/bottom')
        if (slot.wordBreak !== 'normal' && slot.wordBreak !== 'break-word') {
          add(`${path}.wordBreak`, "expected 'normal' or 'break-word'")
        }
        const anchor = slot.anchor as TextAnchor | undefined
        if (!isRecord(anchor)) {
          add(`${path}.anchor`, 'expected an object')
        } else if (anchor.kind === 'fixed') {
          if (!isFiniteNumber(anchor.y) || anchor.y < 0)
            add(`${path}.anchor.y`, 'expected a number >= 0')
          if (!isFiniteNumber(anchor.height) || anchor.height <= 0) {
            add(`${path}.anchor.height`, 'expected a number > 0')
          }
          if (
            isFiniteNumber(anchor.y) &&
            isFiniteNumber(anchor.height) &&
            anchor.y + anchor.height > canvasHeight
          ) {
            add(
              `${path}.anchor.height`,
              `text box exceeds canvas height (${anchor.y + anchor.height} > ${canvasHeight})`
            )
          }
        } else if (anchor.kind === 'aboveVideo') {
          if (!isFiniteNumber(anchor.gap) || anchor.gap < 0)
            add(`${path}.anchor.gap`, 'expected a number >= 0')
          if (!isFiniteNumber(anchor.minY) || anchor.minY < 0)
            add(`${path}.anchor.minY`, 'expected a number >= 0')
        } else {
          add(`${path}.anchor.kind`, "expected 'fixed' or 'aboveVideo'")
        }
        slots.push(slot)
        break
      }
      default:
        add(`${path}.type`, "expected 'video' or 'text'")
    }
  })

  // Rule 3 — exactly one video slot in v1
  if (videoSlots !== 1) {
    add('slots', `expected exactly one video slot, found ${videoSlots}`)
  }

  // Inputs
  const inputs: Template['inputs'] = []
  const inputKeys = new Set<string>()
  if (!Array.isArray(raw.inputs)) {
    add('inputs', 'expected an array')
  } else {
    raw.inputs.forEach((entry, index) => {
      const path = `inputs[${index}]`
      if (!isRecord(entry)) {
        add(path, 'expected an object')
        return
      }
      if (!isNonEmptyString(entry.key)) add(`${path}.key`, 'expected a non-empty string')
      else if (inputKeys.has(entry.key)) add(`${path}.key`, `duplicate input key "${entry.key}"`)
      else inputKeys.add(entry.key)
      if (!isNonEmptyString(entry.label)) add(`${path}.label`, 'expected a non-empty string')
      if (entry.control !== 'text' && entry.control !== 'textarea') {
        add(`${path}.control`, "expected 'text' or 'textarea'")
      }
      if (entry.placeholder !== undefined && typeof entry.placeholder !== 'string') {
        add(`${path}.placeholder`, 'expected a string')
      }
      if (
        entry.maxLength !== undefined &&
        (!isFiniteNumber(entry.maxLength) || entry.maxLength <= 0)
      ) {
        add(`${path}.maxLength`, 'expected a positive number')
      }
      if (entry.required !== undefined && typeof entry.required !== 'boolean') {
        add(`${path}.required`, 'expected a boolean')
      }
      inputs.push(entry as unknown as Template['inputs'][number])
    })
  }

  // Rule 4 — every text slot binds to an input key
  slots.forEach((slot, index) => {
    if (slot.type === 'text' && !inputKeys.has(slot.bindsTo)) {
      add(`slots[${index}].bindsTo`, `no input with key "${slot.bindsTo}"`)
    }
  })

  // Rules 7 + 8 — knobs
  const knobs: KnobDef[] = []
  const knobIds = new Set<string>()
  if (!Array.isArray(raw.knobs)) {
    add('knobs', 'expected an array')
  } else {
    raw.knobs.forEach((entry, index) => {
      const path = `knobs[${index}]`
      if (!isRecord(entry)) {
        add(path, 'expected an object')
        return
      }
      if (typeof entry.id !== 'string' || !isKnobId(entry.id)) {
        add(`${path}.id`, `unknown knob id "${String(entry.id)}" (not in registry)`)
        return
      }
      if (knobIds.has(entry.id)) {
        add(`${path}.id`, `duplicate knob id "${entry.id}"`)
        return
      }
      knobIds.add(entry.id)
      if (!isNonEmptyString(entry.label)) add(`${path}.label`, 'expected a non-empty string')
      if (!['slider', 'select', 'toggle', 'color'].includes(String(entry.control))) {
        add(`${path}.control`, 'expected slider/select/toggle/color')
      }
      const problem = validateKnobValue(entry.id, entry.default)
      if (problem !== null) add(`${path}.default`, problem)

      const spec = KNOB_REGISTRY[entry.id]
      if (entry.control === 'select') {
        if (!Array.isArray(entry.options) || entry.options.length === 0) {
          add(`${path}.options`, 'select knobs need a non-empty options list')
        } else {
          entry.options.forEach((opt: unknown, oi: number) => {
            if (!isRecord(opt) || !('value' in opt) || !isNonEmptyString(opt.label)) {
              add(`${path}.options[${oi}]`, 'expected { value, label }')
            } else if (validateKnobValue(entry.id as never, opt.value) !== null) {
              add(`${path}.options[${oi}].value`, `invalid value for knob "${entry.id}"`)
            }
          })
        }
      } else if (entry.options !== undefined) {
        add(`${path}.options`, 'options are only valid for select knobs')
      }
      if (spec.valueType === 'number' && entry.control === 'slider') {
        // min/max/step are optional but must be sane when present
        for (const key of ['min', 'max', 'step'] as const) {
          if (entry[key] !== undefined && !isFiniteNumber(entry[key])) {
            add(`${path}.${key}`, 'expected a number')
          }
        }
      }
      knobs.push(entry as unknown as KnobDef)
    })
  }

  // Rule 9 — aboveVideo slots must have >= 120px of room at the default videoTop
  const videoSlot = slots.find((s): s is VideoSlot => s.type === 'video')
  if (videoSlot) {
    const videoTopDef = knobs.find((k) => k.id === 'videoTop')?.default
    const defaultVideoTop =
      typeof videoTopDef === 'number' && Number.isFinite(videoTopDef)
        ? videoTopDef
        : (KNOB_REGISTRY.videoTop.default as number)
    slots.forEach((slot, index) => {
      if (slot.type !== 'text' || slot.anchor.kind !== 'aboveVideo') return
      const room = defaultVideoTop - slot.anchor.gap - slot.anchor.minY
      if (room < 120) {
        add(
          `slots[${index}].anchor`,
          `aboveVideo room is ${room}px at default videoTop (expected >= 120px)`
        )
      }
    })
  }

  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    template: {
      ...(raw as unknown as Template),
      canvas: {
        width: canvasWidth,
        height: canvasHeight,
        backgroundStyle,
        ...(blur ? { blur } : {})
      },
      safeZones,
      slots,
      knobs,
      inputs
    }
  }
}

export function assertValidTemplate(raw: unknown): Template {
  const result = validateTemplate(raw)
  if (!result.ok) throw new TemplateValidationError(result.issues)
  return result.template
}

export function describeTemplateIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `  ${issue.path || '(root)'}: ${issue.message}`).join('\n')
}
