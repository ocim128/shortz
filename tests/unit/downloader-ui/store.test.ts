import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DlProgressEvent } from '../../../src/preload/api'
import { useDlStore } from '../../../src/renderer/src/stores/dlStore'

/**
 * The store's actions talk to `window.shortz`; the reducer under test is
 * `applyEvent`. One stub bridge keeps the start/retry paths real without
 * Electron (the module never touches `window` at import time).
 */

const dlStart = vi.fn(async (_req: unknown) => ({ jobId: 'job-1' }))
const dlCancel = vi.fn(async () => undefined)
const dlList = vi.fn(async () => [])
const dlOpenFolder = vi.fn(async () => undefined)
const onDlProgress = vi.fn(() => () => undefined)

beforeEach(() => {
  // dlStore reads the bridge off globalThis (window === globalThis at runtime).
  ;(globalThis as unknown as { shortz: unknown }).shortz = {
    dlStart,
    dlCancel,
    dlList,
    dlOpenFolder,
    onDlProgress,
    revealInExplorer: vi.fn(async () => undefined)
  }
  dlStart.mockClear()
  dlCancel.mockClear()
  useDlStore.setState({ text: '', phase: 'idle', run: null, history: [], error: null })
})

function itemEvent(
  key: string,
  overrides: Partial<NonNullable<DlProgressEvent['item']>> = {},
  index = 0,
  total = 2
): DlProgressEvent {
  return {
    jobId: 'job-1',
    key,
    lineNumber: Number(key.replace(/^line-/, '')) || 1,
    index,
    total,
    kind: 'item',
    item: { tweetId: '1750123456789012352', status: 'downloading', ...overrides }
  }
}

async function startWith(text: string): Promise<void> {
  useDlStore.setState({ text })
  await useDlStore.getState().start()
}

describe('dlStore — rows and run lifecycle', () => {
  it('seeds one row per parsed line and sends every line with its key', async () => {
    await startWith('https://x.com/a/status/1750123456789012352\nnot a link')
    expect(dlStart).toHaveBeenCalledTimes(1)
    const request = dlStart.mock.calls[0]?.[0] as {
      inputs: { key: string; lineNumber: number; text: string }[]
      dryRun?: boolean
    }
    expect(request.inputs.map((input) => input.key)).toEqual(['line-1', 'line-2'])
    expect(request.dryRun).toBeUndefined()
    // The junk line is still sent: main owns the verdict (AUDIT A22).
    expect(request.inputs[1]?.text).toBe('not a link')

    const run = useDlStore.getState().run
    expect(run?.rows.size).toBe(2)
    expect(run?.rows.get('line-2')?.preview).toContain('no-link')
    expect(run?.rows.get('line-2')?.status).toBe('queued')
  })

  it('treats #-prefixed lines as comments: neither sent nor seeded', async () => {
    await startWith('# the funny squirrel one\nhttps://x.com/a/status/1750123456789012352')
    const request = dlStart.mock.calls[0]?.[0] as {
      inputs: { key: string; lineNumber: number; text: string }[]
    }
    expect(request.inputs).toHaveLength(1)
    expect(request.inputs[0]?.key).toBe('line-2')
    expect(request.inputs[0]?.lineNumber).toBe(2)
    expect(useDlStore.getState().run?.rows.size).toBe(1)
  })

  it('analyze is the same run with dryRun: true', async () => {
    useDlStore.setState({ text: 'https://x.com/a/status/1750123456789012352' })
    await useDlStore.getState().analyze()
    expect(dlStart.mock.calls[0]?.[0]).toMatchObject({ dryRun: true })
  })

  it('keys rows by event key and appends unseen keys (retry rows)', () => {
    useDlStore.setState({
      text: 'https://x.com/a/status/1750123456789012352',
      phase: 'running',
      run: {
        jobId: 'job-1',
        mode: 'download',
        rows: new Map(),
        order: [],
        itemTotal: 1,
        activeIndex: -1,
        summary: null,
        cancelled: false
      }
    })

    useDlStore.getState().applyEvent(
      itemEvent('line-1', {
        status: 'ok',
        author: 'someuser',
        caption: 'a squirrel',
        files: ['C:\\clips\\1750123456789012352.mp4'],
        media: [{ index: 1, status: 'ok', bytes: 2048, total: 2048 }]
      })
    )
    useDlStore
      .getState()
      .applyEvent(
        itemEvent(
          'retry-1750999999999999999',
          { tweetId: '1750999999999999999', status: 'failed' },
          1,
          2
        )
      )

    const run = useDlStore.getState().run
    expect(run?.order).toEqual(['line-1', 'retry-1750999999999999999'])
    expect(run?.rows.get('line-1')).toMatchObject({
      status: 'ok',
      author: 'someuser',
      caption: 'a squirrel',
      index: 0
    })
    expect(run?.rows.get('retry-1750999999999999999')?.tweetId).toBe('1750999999999999999')
  })

  it('a media tick moves the row to downloading and cannot regress a terminal row', () => {
    useDlStore.setState({
      text: 'https://x.com/a/status/1750123456789012352',
      phase: 'running',
      run: {
        jobId: 'job-1',
        mode: 'download',
        rows: new Map([
          [
            'line-1',
            {
              key: 'line-1',
              lineNumber: 1,
              text: '',
              preview: [],
              tweetId: '1750123456789012352',
              status: 'ok',
              index: 0
            }
          ]
        ]),
        order: ['line-1'],
        itemTotal: 1,
        activeIndex: -1,
        summary: null,
        cancelled: false
      }
    })

    useDlStore.getState().applyEvent({
      jobId: 'job-1',
      key: 'line-1',
      lineNumber: 1,
      index: 0,
      total: 1,
      kind: 'media-progress',
      mediaIndex: 1,
      bytes: 512,
      mediaTotal: 1024
    })
    expect(useDlStore.getState().run?.rows.get('line-1')?.status).toBe('ok')
    expect(useDlStore.getState().run?.rows.get('line-1')?.progress).toBeUndefined()
  })

  it('settles in-flight rows on a cancelled run-done and stores the summary', () => {
    useDlStore.setState({
      text: 'https://x.com/a/status/1750123456789012352\nhttps://x.com/b/status/1750123456789012999',
      phase: 'running',
      run: {
        jobId: 'job-1',
        mode: 'download',
        rows: new Map([
          [
            'line-1',
            {
              key: 'line-1',
              lineNumber: 1,
              text: '',
              preview: [],
              tweetId: '1750123456789012352',
              status: 'downloading',
              index: 0
            }
          ],
          [
            'line-2',
            {
              key: 'line-2',
              lineNumber: 2,
              text: '',
              preview: [],
              tweetId: '1750123456789012999',
              status: 'queued',
              index: 1
            }
          ]
        ]),
        order: ['line-1', 'line-2'],
        itemTotal: 2,
        activeIndex: 0,
        summary: null,
        cancelled: false
      }
    })

    useDlStore.getState().applyEvent({
      jobId: 'job-1',
      key: '',
      lineNumber: 0,
      index: 2,
      total: 2,
      kind: 'run-done',
      summary: { ok: 0, skipped: 0, partial: 0, failed: 0, cancelled: 2 }
    })

    const state = useDlStore.getState()
    expect(state.phase).toBe('finished')
    expect(state.run?.cancelled).toBe(true)
    expect(state.run?.summary).toEqual({ ok: 0, skipped: 0, partial: 0, failed: 0, cancelled: 2 })
    expect(state.run?.rows.get('line-1')?.status).toBe('cancelled')
    expect(state.run?.rows.get('line-2')?.status).toBe('cancelled')
  })

  it('retry-failed starts from the state index with an empty textarea', async () => {
    useDlStore.setState({ text: '' })
    await useDlStore.getState().retryFailed()
    expect(dlStart).toHaveBeenCalledTimes(1)
    expect(dlStart.mock.calls[0]?.[0]).toEqual({ inputs: [], retryFailed: true })

    // Main synthesises retry keys; the empty snapshot must not reject them.
    useDlStore
      .getState()
      .applyEvent(itemEvent('retry-1750123456789012352', { status: 'resolving' }))
    const run = useDlStore.getState().run
    expect(run?.mode).toBe('retry')
    expect(run?.order).toEqual(['retry-1750123456789012352'])
  })
})
