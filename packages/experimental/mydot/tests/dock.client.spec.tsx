// @vitest-environment jsdom
/** The user selects exact job IDs; uncertain delivery retains the request and draft. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ViewState, DockProps } from '../src/client/props.ts'
import { MyDotDock } from '../src/client/Dock.tsx'
import { createMyDotStore } from '../src/client/store.ts'
import { ja } from '../src/client/locales.ts'
import { clientCommands } from './client-commands.client.ts'

afterEach(cleanup)
function setup(send = vi.fn(async () => {})) {
  const state = createMyDotStore().create('parent')
  state.actions.expand(true)
  const source = createSnapshotStore<ViewState>({ phase: 'ready', value: {
    spaces: [], conversations: [], artifacts: [], desktop: { phase: 'free', inFlight: 0 },
    jobs: ['A', 'B'].map(name => ({ parentSessionId: 'parent' as SessionId, childSessionId: name as SessionId, label: `仕事 ${name}`, mode: 'continuable', status: 'running' })),
  } })
  const stop = vi.fn(async (_job: unknown) => {})
  const props = { ...clientCommands(), sessionId: 'parent' as SessionId, useMydot: bindSnapshotSelector(source), useStore: bindSnapshotSelector(state), actions: state.actions,
    t: makeTranslate(ja), send, stop, open: vi.fn(), newRequestId: () => 'stable-request', retry: vi.fn(), readFile: vi.fn(), startJob: vi.fn(), preview: vi.fn(), flushPreview: vi.fn(),
  } satisfies DockProps
  return { state, source, props, send, stop }
}

it('routes Japanese steering to A once and leaves B untouched; stopping waits for live completion', async () => {
  const b = setup()
  render(<MyDotDock {...b.props} />)
  fireEvent.change(screen.getByLabelText('指示先：親の会話'), { target: { value: 'A' } })
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A のみ変更' } })
  fireEvent.change(screen.getByLabelText('送信方法'), { target: { value: 'steer' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送信' })) })
  expect(b.send).toHaveBeenCalledExactlyOnceWith('parent', { requestId: 'stable-request', text: 'A のみ変更', target: 'A', delivery: 'steer' })
  const stopButtons = screen.getAllByRole('button', { name: 'この仕事を停止' })
  await act(async () => { fireEvent.click(stopButtons[0]!) })
  expect(b.stop.mock.calls[0]?.[0]).toMatchObject({ childSessionId: 'A', parentSessionId: 'parent' })
  expect(screen.getByText(ja.stopping)).toBeTruthy()
  act(() => {
    const current = b.source.getSnapshot()
    if (current.phase !== 'ready') return
    b.source.set({ phase: 'ready', value: { ...current.value, jobs: current.value.jobs.map(job => job.childSessionId === 'A' ? { ...job, status: 'inactive' } : job) } })
  })
  expect(screen.getByText(ja.stopped)).toBeTruthy()
  expect(screen.getAllByText('仕事 B')).toHaveLength(2)
})

it('keeps the same uncertain request across remount and never automatically resends it', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValue(undefined)
  const b = setup(send)
  const first = render(<MyDotDock {...b.props} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '草稿' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送信' })) })
  expect(screen.getByText(ja.uncertain)).toBeTruthy()
  first.unmount()
  render(<MyDotDock {...b.props} />)
  expect(send).toHaveBeenCalledTimes(1)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('草稿')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '再試行' })) })
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
})

it('disables resubmission until the exact pending request receives a receipt', async () => {
  const delivery = Promise.withResolvers<undefined>()
  const send = vi.fn(() => delivery.promise)
  const b = setup(send)
  render(<MyDotDock {...b.props} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'One request only' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: ja.send })) })
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: ja.retry })
  expect(retry.disabled).toBe(true)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').disabled).toBe(true)
  fireEvent.click(retry)
  expect(send).toHaveBeenCalledOnce()
  expect(b.state.getSnapshot().pending).toMatchObject({ requestId: 'stable-request', text: 'One request only' })
  await act(async () => { delivery.resolve(undefined) })
  expect(screen.getByText(ja.accepted)).toBeTruthy()
  expect(b.state.getSnapshot().pending).toBeNull()
})

it('retains both initial job requests and their IDs after a partial start failure and remount', async () => {
  const b = setup()
  const startJob = vi.fn().mockRejectedValueOnce(new Error('lost receipt')).mockResolvedValue(undefined)
  const props = { ...b.props, startJob, newRequestId: vi.fn().mockReturnValueOnce('initial-a').mockReturnValueOnce('initial-b') }
  const first = render(<MyDotDock {...props} />)
  fireEvent.click(screen.getByRole('button', { name: ja.startJobs }))
  for (const [key, text] of [['labelA', 'A'], ['labelB', 'B'], ['requestA', 'Read report A'], ['requestB', 'Read report B']] as const) {
    fireEvent.change(screen.getByLabelText(ja[key]), { target: { value: text } })
  }
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: ja.startJobs }).at(-1)!) })
  first.unmount()
  render(<MyDotDock {...props} />)
  expect(screen.getByLabelText<HTMLTextAreaElement>(ja.requestA).value).toBe('Read report A')
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: ja.startJobs }).at(-1)!) })
  expect(startJob.mock.calls[2]).toEqual(startJob.mock.calls[0])
  expect(startJob.mock.calls[3]).toEqual(startJob.mock.calls[1])
  expect(props.newRequestId).toHaveBeenCalledTimes(2)
})
