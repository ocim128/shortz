import type { TemplateMeta } from '../../../preload/api'

/**
 * Mock template data for the picker + preview — hardcoded in the renderer on
 * purpose (agent split: resources/templates/ is Agent A's lane). Template 1 is
 * the schema doc's JSON verbatim. Delete this file at engine integration and
 * use the bodies returned by listTemplates().
 */

export interface MockTemplate extends TemplateMeta {
  body: NonNullable<TemplateMeta['body']>
}

export const mockTemplates: MockTemplate[] = [
  {
    id: 'hook-letterbox',
    name: 'Hook Letterbox',
    description: 'Clip letterboxed upper-center, bold hook on top. Classic story opener.',
    badge: 'built-in',
    valid: true,
    body: {
      canvas: { backgroundStyle: 'black' },
      safeZones: { top: 150, right: 140, bottom: 420, left: 0 },
      videoSlot: { x: 0, y: 520, width: 1080, height: 980, fit: 'contain', cornerRadius: 24 },
      textSlots: [
        {
          bindsTo: 'hook',
          x: 48,
          width: 880,
          anchor: { kind: 'aboveVideo', gap: 32, minY: 150 },
          fontFamily: 'inter',
          fontWeight: 600,
          fontSize: 68,
          fontSizeMin: 44,
          lineHeight: 1.25,
          color: '#FFFFFF',
          align: 'left',
          vAlign: 'bottom',
          maxLines: 4
        }
      ],
      knobs: [
        {
          id: 'backgroundStyle',
          label: 'Background',
          control: 'select',
          default: 'black',
          options: [
            { value: 'black', label: 'Black' },
            { value: 'white', label: 'White' },
            { value: 'darkGray', label: 'Dark gray' },
            { value: 'blurVideo', label: 'Blurred video' }
          ]
        },
        {
          id: 'videoTop',
          label: 'Video position ↓',
          control: 'slider',
          default: 520,
          min: 480,
          max: 700,
          step: 4
        },
        {
          id: 'videoCornerRadius',
          label: 'Corner rounding',
          control: 'slider',
          default: 24,
          min: 0,
          max: 48,
          step: 4
        },
        {
          id: 'textAlign',
          label: 'Text align',
          control: 'select',
          default: 'left',
          options: [
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Center' }
          ]
        }
      ],
      inputs: [
        {
          key: 'hook',
          label: 'Hook text',
          control: 'textarea',
          placeholder: 'A wildlife photographer put a microphone beside a baby squirrel…',
          maxLength: 220,
          required: true,
          maxLines: 4
        }
      ]
    }
  },
  {
    id: 'blur-letterbox',
    name: 'Blur Letterbox',
    description: 'Blurred fullscreen copy behind the letterboxed clip — the repost look.',
    badge: 'built-in',
    valid: true,
    body: {
      canvas: { backgroundStyle: 'blurVideo' },
      safeZones: { top: 150, right: 140, bottom: 420, left: 0 },
      videoSlot: { x: 0, y: 560, width: 1080, height: 940, fit: 'contain', cornerRadius: 32 },
      textSlots: [
        {
          bindsTo: 'hook',
          x: 48,
          width: 880,
          anchor: { kind: 'aboveVideo', gap: 32, minY: 150 },
          fontFamily: 'poppins',
          fontWeight: 600,
          fontSize: 64,
          fontSizeMin: 44,
          lineHeight: 1.25,
          color: '#FFFFFF',
          align: 'left',
          vAlign: 'bottom',
          maxLines: 4
        }
      ],
      knobs: [
        {
          id: 'videoTop',
          label: 'Video position ↓',
          control: 'slider',
          default: 560,
          min: 480,
          max: 700,
          step: 4
        },
        {
          id: 'videoCornerRadius',
          label: 'Corner rounding',
          control: 'slider',
          default: 32,
          min: 0,
          max: 48,
          step: 4
        },
        {
          id: 'textAlign',
          label: 'Text align',
          control: 'select',
          default: 'left',
          options: [
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Center' }
          ]
        }
      ],
      inputs: [
        {
          key: 'hook',
          label: 'Hook text',
          control: 'textarea',
          placeholder: 'Type the hook…',
          maxLength: 220,
          required: true,
          maxLines: 4
        }
      ]
    }
  },
  {
    // Invalid user template — shows greyed with ⚠ tooltip (ui-spec §template picker).
    id: 'my-giant-text',
    name: 'my-giant-text',
    description: 'User template (invalid)',
    badge: 'user',
    valid: false,
    error: 'slots[1].anchor: computed height (video.y − gap) − minY = 96px, below the 120px minimum for aboveVideo slots',
    body: {
      canvas: { backgroundStyle: 'black' },
      safeZones: { top: 150, right: 140, bottom: 420, left: 0 },
      videoSlot: { x: 0, y: 520, width: 1080, height: 980, fit: 'contain', cornerRadius: 24 },
      textSlots: [],
      knobs: [],
      inputs: []
    }
  }
]

export function findMockTemplate(id: string): MockTemplate | undefined {
  return mockTemplates.find((t) => t.id === id)
}
