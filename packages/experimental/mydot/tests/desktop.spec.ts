/** Software ownership never confirms a handoff while a desktop call remains active. */
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DesktopOwnership } from '../src/desktop.ts'

it('serializes desktop owners, drains operations before human handoff, and requires a fresh capture to resume', () => {
  const pc = new DesktopOwnership()
  const a = SessionId('A')
  const b = SessionId('B')
  pc.claim(a)
  expect(() =>{  pc.claim(b) }).toThrow('owned')
  const complete = pc.begin(a)
  expect(pc.requestHandoff()).toMatchObject({ phase: 'stopping', owner: a })
  expect(() => pc.begin(a)).toThrow('stopping')
  complete()
  expect(pc.snapshot()).toMatchObject({ phase: 'human', owner: a })
  expect(() => pc.resume(a, 10)).toThrow('fresh')
  pc.observed(11)
  expect(pc.resume(a, 11)).toMatchObject({ phase: 'agent', owner: a, capturedAt: 11 })
  expect(() => pc.begin(b)).toThrow('owned')
})

it('waits for ownership release, cancels waiting admission, and permits only fresh observation during human ownership', async () => {
  const pc = new DesktopOwnership()
  const a = SessionId('A')
  const b = SessionId('B')
  const done = await pc.acquire(a, new AbortController().signal)
  const cancellation = new AbortController()
  const cancelled = pc.acquire(b, cancellation.signal)
  cancellation.abort(new Error('cancelled waiting'))
  await expect(cancelled).rejects.toThrow('cancelled waiting')
  const waiting = pc.acquire(b, new AbortController().signal)
  done()
  pc.release(a)
  const finishB = await waiting
  expect(pc.snapshot()).toMatchObject({ owner: b, phase: 'agent', inFlight: 1 })
  pc.requestHandoff()
  finishB()
  const captureDone = await pc.acquire(b, new AbortController().signal, true)
  expect(() => pc.resume(b, 20)).toThrow('fresh')
  pc.observed(20)
  captureDone()
  expect(pc.snapshot().phase).toBe('human')
  expect(pc.resume(b, 20).phase).toBe('agent')
})
