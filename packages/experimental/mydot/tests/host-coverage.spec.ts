/** Host admission, recorded context, authorization and lifecycle regression coverage. */
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { Config, SpaceId } from '../src/index.ts'
import '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(config: Partial<Config> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mydot-host-')))
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await liveConfig(ctx, SubagentRuntime, {})
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('memory', backend))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  ctx.provide('storageDomain', facility)
  ctx.effect(() => async () => { await facility.closeAll(); await backend.close() })
  ctx.provide('sessionController', {} as never)
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([{ name: '@deepseek-ai/dsh-experimental-mydot', config: { memoryDirectory: join(root, 'memory'), ...config } }]))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.loader.builtins.include = Include
  ctx.loader.internal = undefined
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-experimental-mydot')!
  return { ctx, root, entry }
}
const signal = (): AbortSignal => new AbortController().signal
const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const spaceInput = { name: 'Research', purpose: 'Compare the report', instructions: 'Cite sources', materials: [] }

it('rejects invalid admission and missing parents without reserving the identity', async () => {
  const { ctx } = await setup()
  const request = { parentSessionId: SessionId('missing'), requestId: 'retry' as SessionRequestId, label: 'A', prompt: 'Analyze', provider: 'spawn' as const }
  await expect(ctx.mydot.startJob({ ...request, label: ' ' }, signal())).rejects.toThrow('name and request')
  await expect(ctx.mydot.startJob({ ...request, prompt: ' ' }, signal())).rejects.toThrow('name and request')
  await expect(ctx.mydot.startJob(request, signal())).rejects.toThrow('Resume the original parent')
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done'), textResponse('received')]))
  const parent = await ctx.agentLoop.create(request.parentSessionId, { provider: 'mock', model: 'mock' })
  expect((await ctx.mydot.startJob(request, signal())).childSessionId).toBe('mydot-retry')
  await ctx.subagents.waitForChildren(parent)
})

it('shares pending starts and compares cataloged requests after Host reload', async () => {
  const { ctx, root, entry } = await setup()
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('child result'), textResponse('received')]))
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const request = { parentSessionId: parent.id, requestId: 'pending' as SessionRequestId, label: 'A', prompt: 'Analyze', provider: 'spawn' as const }
  const gate = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const list = ctx.subagents.listChildren.bind(ctx.subagents)
  const spy = vi.spyOn(ctx.subagents, 'listChildren').mockImplementationOnce(async (...args) => { entered.resolve(undefined); await gate.promise; return list(...args) })
  const first = ctx.mydot.startJob(request, signal())
  await entered.promise
  const second = ctx.mydot.startJob(request, signal())
  await expect(ctx.mydot.startJob({ ...request, label: 'Changed' }, signal())).rejects.toThrow('different')
  gate.resolve(undefined)
  expect(await first).toEqual(await second)
  spy.mockRestore()
  await ctx.subagents.waitForChildren(parent)
  await entry.update({ disabled: true })
  await entry.update({ disabled: false })
  await entry.fiber!.await()
  expect(await ctx.mydot.startJob(request, signal())).toEqual({ childSessionId: SessionId('mydot-pending') })
  await expect(ctx.mydot.startJob({ ...request, prompt: 'Changed' }, signal())).rejects.toThrow('different')
})

it('records Space context as durable model input with absent memories omitted', async () => {
  const { ctx, root } = await setup()
  const adapter = new MockAdapter([textResponse('ready')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('snapshot-parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const space = await ctx.mydot.saveSpace(spaceInput)
  await ctx.mydot.attach(parent.id, space.id)
  parent.followup(message('Read the report'))
  await parent.whenIdle()
  using source = await ctx.sessionQuery.observeSession(parent.id)
  const recorded = source.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'mydot' ? [event.data] : [])
  expect(recorded).toHaveLength(1)
  const block = recorded[0]!.content.find(block => block.type === 'text')!
  const content = JSON.parse(block.text)
  expect({ ...content, space: { ...content.space, id: '<space-id>' } }).toMatchInlineSnapshot(`
    {
      "memory": [],
      "space": {
        "id": "<space-id>",
        "instructions": "Cite sources",
        "materials": [],
        "name": "Research",
        "purpose": "Compare the report",
      },
    }
  `)
  expect(adapter.requests[0]?.messages.some(item => JSON.stringify(item).includes('Compare the report'))).toBe(true)
})

it('authorizes materials and declared artifacts outside cwd while denying unrelated files', async () => {
  const { ctx, root } = await setup()
  await mkdir(join(root, 'work'))
  const parent = await ctx.agentLoop.create(SessionId('files'), {}, { cwd: join(root, 'work') })
  const material = join(root, 'material.md')
  const artifact = join(root, 'artifact.md')
  await writeFile(material, 'material')
  await writeFile(artifact, 'artifact')
  const space = await ctx.mydot.saveSpace({ ...spaceInput, materials: [material] })
  await ctx.mydot.attach(parent.id, space.id)
  parent.session.append('deliverables/presented', { files: [{ path: artifact, description: 'report' }] })
  expect(await ctx.mydot.readFile(parent.id, material)).toMatchObject({ content: 'material' })
  expect(await ctx.mydot.readFile(parent.id, artifact)).toMatchObject({ content: 'artifact' })
  await expect(ctx.mydot.readFile(parent.id, join(root, 'private.md'))).rejects.toThrow('Select a file referenced')
  expect((await ctx.mydot.saveFile(parent.id, { path: 'draft.md', content: 'draft', version: null })).kind).toBe('saved')
  const unknown = 'absent-space' as SpaceId
  await expect(ctx.mydot.readMemory({ kind: 'space', spaceId: unknown })).rejects.toThrow('Space not found')
  await expect(ctx.mydot.saveMemory({ kind: 'space', spaceId: unknown }, { content: 'x', version: null })).rejects.toThrow('Space not found')
  expect(await ctx.mydot.readMemory({ kind: 'personal' })).toMatchObject({ kind: 'missing' })
  expect((await ctx.mydot.snapshot()).artifacts).toMatchObject([{ description: 'report', available: true, parentSessionId: parent.id }])
  const unbound = await ctx.agentLoop.create(SessionId('unbound'), {}, { cwd: join(root, 'work') })
  await expect(ctx.mydot.readFile(unbound.id, material)).rejects.toThrow('Select a file referenced')
})

it('retains associations and reports independent catalog and observation errors', async () => {
  const { ctx, root } = await setup()
  const parent = await ctx.agentLoop.create(SessionId('unavailable'), {}, { cwd: root })
  const space = await ctx.mydot.saveSpace(spaceInput)
  await ctx.mydot.attach(parent.id, space.id)
  vi.spyOn(ctx.subagents, 'listChildren').mockRejectedValue(new Error('catalog unavailable'))
  vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('session unavailable'))
  expect(await ctx.mydot.snapshot()).toMatchObject({ spaces: [space], conversations: [], issues: [
    { sessionId: parent.id, kind: 'unavailable' }, { sessionId: parent.id, kind: 'unavailable' },
  ] })
})

it('wakes subscriptions on metadata changes and cancels parked and pre-cancelled watches', async () => {
  const { ctx } = await setup()
  const cancel = new AbortController()
  const watch = ctx.mydot.watch(cancel.signal)[Symbol.asyncIterator]()
  expect((await watch.next()).value?.spaces).toEqual([])
  const next = watch.next()
  await ctx.mydot.saveSpace(spaceInput)
  expect((await next).value?.spaces).toHaveLength(1)
  const parked = watch.next()
  cancel.abort()
  expect(await parked).toEqual({ done: true, value: undefined })
  const stopped = new AbortController(); stopped.abort()
  expect(await ctx.mydot.watch(stopped.signal)[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
})

it('unloads a parked watch while pending admission settles', async () => {
  const { ctx, entry } = await setup()
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
  const parent = await ctx.agentLoop.create(SessionId('unload'), { provider: 'mock', model: 'mock' })
  const watch = ctx.mydot.watch(signal())[Symbol.asyncIterator]()
  await watch.next()
  const parked = watch.next()
  const gate = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const list = ctx.subagents.listChildren.bind(ctx.subagents)
  vi.spyOn(ctx.subagents, 'listChildren').mockImplementationOnce(async (...args) => { entered.resolve(undefined); await gate.promise; return list(...args) })
  const start = ctx.mydot.startJob({ parentSessionId: parent.id, requestId: 'unload' as SessionRequestId, label: 'A', prompt: 'work', provider: 'spawn' }, signal())
  await entered.promise
  const disposal = entry.update({ disabled: true })
  gate.resolve(undefined)
  await start
  await disposal
  expect(await parked).toEqual({ done: true, value: undefined })
  await ctx.subagents.waitForChildren(parent)
  expect(ctx.get('mydot')).toBeUndefined()
})

it('coordinates desktop actions, human capture and quiescence through actual tools', async () => {
  const { ctx, root } = await setup({ desktopTools: ['action', 'capture'], captureTools: ['capture'] })
  const parent = await ctx.agentLoop.create(SessionId('desktop'), {}, { cwd: root })
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  ctx.tools.register(defineContentToolFixture({ name: 'action', description: '', parameters: {}, async execute() {
    entered.resolve(undefined); await finish.promise; return [{ type: 'text', text: 'acted' }]
  } }))
  ctx.tools.register(defineContentToolFixture({ name: 'capture', description: '', parameters: {}, async execute() {
    return [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]
  } }))
  const execute = (name: string) => ctx.tools.execute({ name, arguments: {}, callId: ToolCallId(name), signal: signal(), agent: parent })
  const active = execute('action')
  await entered.promise
  expect(ctx.mydot.handoffDesktop()).toMatchObject({ phase: 'stopping', inFlight: 1 })
  finish.resolve(undefined)
  await active
  expect((await ctx.mydot.snapshot()).desktop).toMatchObject({ phase: 'human', inFlight: 0 })
  await execute('capture')
  const capturedAt = (await ctx.mydot.snapshot()).desktop.capturedAt!
  expect(ctx.mydot.resumeDesktop(parent.id, capturedAt)).toMatchObject({ phase: 'agent', capturedAt })
  expect(ctx.mydot.releaseDesktop(parent.id)).toEqual({ phase: 'free', inFlight: 0 })
  await ctx.tools.execute({ name: 'capture', arguments: {}, callId: ToolCallId('without-agent'), signal: signal() })
  expect((await ctx.mydot.snapshot()).desktop.phase).toBe('free')
})
