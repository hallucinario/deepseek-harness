/** Exact existing parent/child routing, without name-based addressing or queue mutation. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { JobControls } from '../src/control.ts'
import type { JobInput } from '../src/types.ts'

it('addresses only A, preserves request identity and reports stop admission separately', async () => {
  const prompt = vi.fn(async (_input: unknown) => ({ messageId: 'accepted' }))
  const interruptByParent = vi.fn(() => ({ accepted: true }))
  const ctx = { subagents: { prompt, interruptByParent, listChildren: async () => [{ id: 'A', mode: 'continuable' }] }, sessionQuery: { observeSession: async () => ({ events: [], inheritedEventCount: 0, [Symbol.dispose]() {} }) } } as never as Context
  const controls = new JobControls(ctx)
  const request: JobInput = { parentSessionId: SessionId('parent'), childSessionId: SessionId('A'), requestId: 'same-request' as JobInput['requestId'], delivery: 'steer', text: 'change A only' }
  await controls.send(request, new AbortController().signal)
  await controls.send(request, new AbortController().signal)
  expect(prompt.mock.calls.map(call => call[0])).toEqual([{
    parentSessionId: 'parent', childSessionId: 'A', mode: 'continuable', requestId: 'same-request', delivery: 'steer', content: [{ type: 'text', text: 'change A only' }],
  }, {
    parentSessionId: 'parent', childSessionId: 'A', mode: 'continuable', requestId: 'same-request', delivery: 'steer', content: [{ type: 'text', text: 'change A only' }],
  }])
  expect(controls.stop({ parentSessionId: SessionId('parent'), childSessionId: SessionId('A') })).toEqual({ accepted: true })
  expect(interruptByParent).toHaveBeenCalledExactlyOnceWith('A', 'parent', 'continuable')
})
