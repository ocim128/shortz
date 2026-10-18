import type { BackgroundStyle, KnobDef } from './types'

/**
 * Fixed registry of knob ids the Layout Engine understands.
 * Templates merely declare knobs; the engine consumes them with explicit typed code.
 * Extending the registry = adding one typed handler in the engine (a code change, by design).
 */
export type KnobId =
  | 'backgroundStyle'
  | 'videoTop'
  | 'videoCornerRadius'
  | 'videoScale'
  | 'videoFraming'
  | 'textAlign'
  | 'textFont'
  | 'textMaxLines'

export interface KnobSpec {
  id: KnobId
  label: string
  valueType: 'number' | 'string'
  default: number | string
  min?: number
  max?: number
  step?: number
  options?: readonly string[]
}

export const KNOB_REGISTRY: Record<KnobId, KnobSpec> = {
  backgroundStyle: {
    id: 'backgroundStyle',
    label: 'Background',
    valueType: 'string',
    default: 'black',
    options: ['black', 'white', 'darkGray', 'blurVideo']
  },
  videoTop: {
    id: 'videoTop',
    label: 'Video position',
    valueType: 'number',
    default: 520,
    min: 480,
    max: 700,
    step: 4
  },
  videoCornerRadius: {
    id: 'videoCornerRadius',
    label: 'Corner rounding',
    valueType: 'number',
    default: 24,
    min: 0,
    max: 48,
    step: 4
  },
  videoScale: {
    id: 'videoScale',
    label: 'Video scale',
    valueType: 'number',
    default: 1,
    min: 0.85,
    max: 1,
    step: 0.01
  },
  videoFraming: {
    id: 'videoFraming',
    label: 'Framing',
    valueType: 'string',
    default: 'letterbox',
    options: ['letterbox', 'auto', 'fill']
  },
  textAlign: {
    id: 'textAlign',
    label: 'Text align',
    valueType: 'string',
    default: 'left',
    options: ['left', 'center', 'right']
  },
  textFont: {
    id: 'textFont',
    label: 'Font',
    valueType: 'string',
    default: 'inter',
    options: ['inter', 'poppins']
  },
  textMaxLines: {
    id: 'textMaxLines',
    label: 'Max lines',
    valueType: 'number',
    default: 4,
    min: 2,
    max: 6,
    step: 1
  }
}

export const KNOB_IDS = Object.keys(KNOB_REGISTRY) as KnobId[]

export function isKnobId(id: string): id is KnobId {
  return Object.prototype.hasOwnProperty.call(KNOB_REGISTRY, id)
}

/** Returns null when valid, otherwise a human-readable problem description. */
export function validateKnobValue(id: KnobId, value: unknown): string | null {
  const spec = KNOB_REGISTRY[id]
  if (spec.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `expected a number`
    if (spec.min !== undefined && value < spec.min) return `expected >= ${spec.min}`
    if (spec.max !== undefined && value > spec.max) return `expected <= ${spec.max}`
    return null
  }
  if (typeof value !== 'string') return `expected a string`
  if (spec.options && !spec.options.includes(value)) {
    return `expected one of ${spec.options.join(', ')}`
  }
  return null
}

export interface ResolvedKnobs {
  values: Record<KnobId, number | string>
  warnings: string[]
}

/**
 * Merge order: registry defaults ← template knob defaults ← user overrides.
 * Invalid overrides are ignored with a non-fatal warning.
 */
export function resolveKnobValues(
  knobDefs: KnobDef[],
  overrides: Partial<Record<KnobId, unknown>> | undefined
): ResolvedKnobs {
  const values = {} as Record<KnobId, number | string>
  for (const id of KNOB_IDS) {
    values[id] = KNOB_REGISTRY[id].default
  }

  for (const def of knobDefs) {
    const problem = validateKnobValue(def.id, def.default)
    if (problem === null) {
      values[def.id] = def.default as number | string
    }
  }

  const warnings: string[] = []
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!isKnobId(key)) {
        warnings.push(`Unknown knob "${key}" ignored`)
        continue
      }
      const problem = validateKnobValue(key, value)
      if (problem === null) {
        values[key] = value as number | string
      } else {
        warnings.push(`Knob "${key}" value invalid (${problem}); using default`)
      }
    }
  }

  return { values, warnings }
}

export type { BackgroundStyle }
