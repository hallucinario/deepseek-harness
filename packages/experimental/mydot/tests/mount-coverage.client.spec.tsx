// @vitest-environment jsdom
/** Registered commands preserve source addresses and unload slots before their Remote contribution. */
import { afterEach, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { FsVersion } from '@deepseek-ai/dsh-fs/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SpaceId, MyDotSnapshot, TextSave } from '../src/types.ts'
import type { Commands } from '../src/client/props.ts'
import { mountMyDot, inject } from '../src/client/mount.ts'

const runtimes: SlotTestRuntime[] = []
afterEach(async () => { for (const rt of runtimes.splice(0)) await rt.dispose() })
const parent = 'parent' as SessionId
const child = 'child' as SessionId
const spaceId = 'space' as SpaceId
const contribution = { package: '@deepseek-ai/dsh-experimental-mydot', descriptors: [] }
function stream() {
  let wake: (() => void) | undefined
  let done = false
  let error: Error | undefined
  const values: MyDotSnapshot[] = []
  return {
    push(value: MyDotSnapshot) { values.push(value)
      wake?.() },
    fail() { error = new Error('offline')
      wake?.() },
    dispose: vi.fn(() => { done = true
      wake?.() }),
    end() { done = true
      wake?.() },
    async *[Symbol.asyncIterator]() { while (!done) { if (error !== undefined) throw error
      const value = values.shift()
      if (value !== undefined) yield value
      else await new Promise<void>((resolve) => { wake = resolve }) } },
  }
}
async function bench() {
  const rt = await SlotTestRuntime.create()
  runtimes.push(rt)
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  const openSession = vi.fn()
  const openResource = vi.fn()
  const mounted = createSnapshotStore<SessionId | null>(null)
  rt.ctx.provide('uiWorkspace', { openSession } as never)
  rt.ctx.provide('sidebarRight', { mounted, openResource } as never)
  rt.ctx.provide('layout', {} as never)
  const streams: ReturnType<typeof stream>[] = []
  const watch = vi.fn(() => { const s = stream()
    streams.push(s)
    return s })
  const result = { ok: true as const, value: undefined }
  const call = () => vi.fn(async (..._args: unknown[]) => result)
  const remote = {
    watch, presentResults: call(), releaseDesktop: call(), saveSpace: call(), attach: call(),
    createConversation: vi.fn(async () => ({ ok: true as const, value: { sessionId: parent } })),
    startJob: call(), send: call(), stop: call(), readFile: call(), saveFile: call(),
    readMemory: call(), saveMemory: call(), continueFile: call(), handoffDesktop: call(), resumeDesktop: call() }
  const prompt = call()
  rt.remote.provideNamespaces({ mydot: remote, session: { prompt } })
  const unmount = vi.fn(async () => { expect(rt.slots.entries('main')).toHaveLength(0) })
  const mount = vi.spyOn(rt.remote, '$mount').mockResolvedValue(unmount)
  await rt.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' }, 'conversation.input.dock': { kind: 'list', scope: 'session' } } as never)
  let dispose: (() => Promise<void>) | undefined
  await rt.mount({ inject, apply: async (ctx) => { dispose = await mountMyDot(ctx, contribution)
    return dispose } })
  const commands = rt.slots.entries('main')[0]!.inject!() as Commands
  const snapshot: MyDotSnapshot = { spaces: [], conversations: [], jobs: [{ parentSessionId: parent, childSessionId: child, label: 'Child', mode: 'continuable', status: 'running' }], artifacts: [], desktop: { phase: 'free', inFlight: 0 } }
  return { rt, remote, prompt, mount, unmount, streams, commands, snapshot, mounted, openSession, openResource, dispose: () => dispose!() }
}

it('mounts the Remote contribution, renders registered root slots and disposes their effects', async () => {
  const b = await bench()
  expect(b.mount).toHaveBeenCalledWith(contribution)
  expect(b.rt.slots.entries('conversation.input.dock')).toHaveLength(1)
  const view = b.rt.renderSlot('main', {}, { entryKey: 'mydot' })
  expect(view.view.getByRole('status')).toBeTruthy()
  await act(async () => { b.streams[0]!.push(b.snapshot) })
  expect(view.view.getByRole('heading', { name: 'MyDot' })).toBeTruthy()
  const icon = b.rt.renderSlot('sidebar.panellist', { size: 16 })
  expect(icon.container.querySelector('svg')).toBeTruthy()
  await act(async () => { await b.dispose() })
  expect(b.unmount).toHaveBeenCalledOnce()
  expect(b.streams[0]!.dispose).toHaveBeenCalledOnce()
})

it('forwards every command, preserves parent/child addresses, and drains a deferred preview after navigation', async () => {
  const b = await bench()
  const c = b.commands
  await act(async () => { b.streams[0]!.push(b.snapshot) })
  await c.presentResults(parent)
  await c.releaseDesktop(parent)
  await c.saveSpace({ name: 'New', purpose: '', instructions: '', materials: [] })
  await c.attach(parent, spaceId)
  await c.createConversation(spaceId)
  await c.startJob({ parentSessionId: parent, requestId: 'start' as never, label: 'Job', prompt: 'Read', provider: 'spawn' })
  await c.send(parent, { requestId: 'send' as never, target: null, text: 'Parent', delivery: 'queue' })
  await c.send(parent, { requestId: 'send-child' as never, target: child, text: 'Child', delivery: 'steer' })
  expect(b.prompt).toHaveBeenCalledWith({ sessionId: parent, requestId: 'send', mode: 'queue', content: [{ type: 'text', text: 'Parent' }] })
  expect(b.remote.send).toHaveBeenCalledWith({ parentSessionId: parent, childSessionId: child, requestId: 'send-child', text: 'Child', delivery: 'steer' })
  const job = b.snapshot.jobs[0]!
  await c.stop(job)
  expect(b.remote.stop).toHaveBeenCalledWith({ parentSessionId: parent, childSessionId: child })
  for (const mode of ['continuable', 'one-shot', 'external'] as const) c.open({ ...job, mode })
  c.openConversation(parent)
  c.openConversation(child)
  expect(b.openSession).toHaveBeenCalledWith({ parentSessionId: parent, childSessionId: child, mode: 'continuable' })
  const file = { sessionId: child, parentSessionId: parent, path: '/report', available: true }
  c.preview(file)
  c.flushPreview(parent)
  c.flushPreview(child)
  expect(b.openResource).not.toHaveBeenCalled()
  b.mounted.set(child)
  c.flushPreview(child)
  c.flushPreview(child)
  c.preview(file)
  expect(b.openResource).toHaveBeenCalledTimes(2)
  b.mounted.set(null)
  c.preview({ ...file, sessionId: parent })
  expect(b.openSession).toHaveBeenCalledWith(parent)
  const edit: TextSave = { path: '/report', content: 'Changed', version: FsVersion('v1') }
  await c.readFile(parent, '/report')
  await c.saveFile(parent, edit)
  await c.readMemory({ kind: 'personal' })
  await c.saveMemory({ kind: 'personal' }, edit)
  await c.continueFile(parent, '/report', FsVersion('v1'))
  await c.handoff()
  await c.resume(parent, 123)
  expect(b.remote.continueFile).toHaveBeenCalledWith(parent, '/report', 'v1', expect.any(String))
  expect(b.remote.resumeDesktop).toHaveBeenCalledWith(parent, 123)
  expect(c.newRequestId()).toEqual(expect.any(String))
  b.remote.presentResults.mockResolvedValueOnce({ ok: false, error: new Error('denied') } as never)
  await expect(c.presentResults(parent)).rejects.toThrow('denied')
})

it('reports stream failure before an opening snapshot and retries or resets without automatic commands', async () => {
  const b = await bench()
  const source = b.commands.hooks.mydot
  b.commands.openConversation(child)
  expect(b.openSession).toHaveBeenCalledWith(child)
  await act(async () => { b.streams[0]!.fail() })
  expect(source.getSnapshot()).toEqual({ phase: 'failed', message: 'unavailable' })
  b.commands.retry()
  expect(b.streams[0]!.dispose).toHaveBeenCalledOnce()
  await act(async () => { b.streams[1]!.push(b.snapshot) })
  await act(async () => { b.streams[1]!.end() })
  expect(source.getSnapshot()).toMatchObject({ phase: 'ready', disconnected: true })
  b.rt.ctx.emit('connection/reset')
  expect(b.remote.watch).toHaveBeenCalledTimes(3)
  await act(async () => { b.streams[2]!.push({ ...b.snapshot, jobs: [{ ...b.snapshot.jobs[0]!, mode: 'one-shot' }] }) })
  b.commands.openConversation(child)
  expect(b.openSession).toHaveBeenLastCalledWith({ parentSessionId: parent, childSessionId: child, mode: 'unknown' })
  expect(b.remote.send).not.toHaveBeenCalled()
})
