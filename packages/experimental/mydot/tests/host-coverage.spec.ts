/** Host admission, recorded context, authorization and lifecycle regression coverage. */
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
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
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
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
  await expect(ctx.mydot.startJob(request, signal())).rejects.toThrow('session "missing" not found')
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
  const retiring = entry.fiber!
  await retiring.dispose()
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
  parent.session.append('deliverables/presented', { turn: 0, callId: ToolCallId('declared'), files: [{ path: artifact, description: 'report' }] })
  parent.session.append('sandbox/mode', { mode: 'workspace-write' })
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
    return [{ type: 'image', attachment: { attachmentId: AttachmentId('fixture-frame'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }]
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

it('creates conversations with the selected workspace or default and rejects archived or missing Spaces', async () => {
  const { ctx, root } = await setup()
  const create = vi.fn<typeof ctx.sessionController.create>().mockImplementation(async () => {
    const sessionId = SessionId(`created-${create.mock.calls.length}`)
    await ctx.agentLoop.create(sessionId, {}, { cwd: root })
    return { sessionId }
  })
  Object.assign(ctx.sessionController, { create })
  const plain = await ctx.mydot.saveSpace(spaceInput)
  const { WorkspaceId } = await import('@deepseek-ai/dsh-workspace')
  const workspaceId = WorkspaceId('selected-workspace')
  const selected = await ctx.mydot.saveSpace({ ...spaceInput, workspaceId })
  const first = await ctx.mydot.createConversation(plain.id)
  const second = await ctx.mydot.createConversation(selected.id)
  expect(create.mock.calls).toEqual([[{}], [{ workspaceId }]])
  expect((await ctx.mydot.snapshot()).conversations).toEqual(expect.arrayContaining([
    expect.objectContaining({ sessionId: first.sessionId, spaceId: plain.id }),
    expect.objectContaining({ sessionId: second.sessionId, spaceId: selected.id }),
  ]))
  await ctx.mydot.saveSpace({ ...plain, archived: true })
  await expect(ctx.mydot.createConversation(plain.id)).rejects.toThrow('non-archived')
  await expect(ctx.mydot.createConversation('missing' as SpaceId)).rejects.toThrow('non-archived')
  expect(create).toHaveBeenCalledTimes(2)
})

it('refuses a persisted parent with no live Agent after its catalog can be read', async () => {
  const { ctx } = await setup()
  const session = ctx.sessions.create(SessionId('cold-parent'))
  expect(await ctx.subagents.listChildren(session.id)).toEqual([])
  await expect(ctx.mydot.startJob({ parentSessionId: session.id, requestId: 'cold' as SessionRequestId,
    label: 'Cold', prompt: 'Work', provider: 'spawn' }, signal())).rejects.toThrow('Resume the original parent')
})

it('continues only the exact current saved file and returns the SessionController receipt', async () => {
  const { ctx, root } = await setup()
  const parent = await ctx.agentLoop.create(SessionId('continue-file'), {}, { cwd: root })
  const receipt = { accepted: true as const }
  const prompt = vi.fn<typeof ctx.sessionController.prompt>().mockResolvedValue(receipt)
  Object.assign(ctx.sessionController, { prompt })
  const saved = await ctx.mydot.saveFile(parent.id, { path: 'draft.md', content: 'saved', version: null })
  expect(saved.kind).toBe('saved')
  if (saved.kind !== 'saved') throw new Error('Expected saved draft')
  const requestId = 'continue-once' as SessionRequestId
  const cancellation = signal()
  expect(await ctx.mydot.continueFile(parent.id, './draft.md', saved.version, requestId, cancellation)).toBe(receipt)
  expect(prompt).toHaveBeenCalledWith({ sessionId: parent.id, requestId, mode: 'queue', content: [{ type: 'text', text:
    'Continue using the saved file. Read it again before working. ' + JSON.stringify({ path: join(root, 'draft.md'), version: saved.version }) }] }, cancellation)
  await writeFile(join(root, 'draft.md'), 'changed since saved')
  await expect(ctx.mydot.continueFile(parent.id, 'draft.md', saved.version, requestId, signal())).rejects.toThrow('File changed after saving')
  await expect(ctx.mydot.continueFile(parent.id, 'missing.md', saved.version, requestId, signal())).rejects.toThrow('File changed after saving')
  expect(prompt).toHaveBeenCalledOnce()
  expect(() => ctx.mydot.handoffDesktop()).toThrow('Configure desktop tool admission')
})

it('projects unlabeled local children and external catalog entries without inheriting external Sessions', async () => {
  const { ctx, root } = await setup({ summaryCharacters: 8 })
  const parent = await ctx.agentLoop.create(SessionId('catalog-parent'), {}, { cwd: root })
  const child = ctx.sessions.create(SessionId('unlabeled-child'), { meta: { cwd: root } })
  child.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'image', attachment: { attachmentId: AttachmentId('image-fixture'), mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
    { type: 'text', text: 'ordinary user input' }, { type: 'text', text: 'MyDot job request: {"prompt":"request"}' },
  ] }), { surfaceOp: 'append' })
  child.append('assistant/message', { stream: [], turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'mock', model: 'mock' }, content: [
    { type: 'text', text: 'First' }, { type: 'reasoning', text: 'private' }, { type: 'text', text: 'second' },
  ] }) }, { surfaceOp: 'append' })
  child.append('deliverables/presented', { turn: 0, callId: ToolCallId('declared'), files: [{ path: 'absent.md' }, { path: '.', description: 'directory' }] })
  parent.session.append('subagent/catalog', { version: 0, childId: child.id, childCreatedAt: 1, mode: 'one-shot' })
  parent.session.append('subagent/catalog', { version: 2, childId: SessionId('external-child'), childCreatedAt: 2, mode: 'external' })
  const space = await ctx.mydot.saveSpace(spaceInput)
  await ctx.mydot.attach(parent.id, space.id)
  const snapshot = await ctx.mydot.snapshot()
  expect(snapshot.jobs).toEqual([
    { parentSessionId: parent.id, childSessionId: child.id, label: child.id, mode: 'one-shot', status: 'inactive', request: 'request', summary: 'First se' },
    { parentSessionId: parent.id, childSessionId: 'external-child', label: 'external-child', mode: 'external', status: 'inactive' },
  ])
  expect(snapshot.conversations.map(item => item.sessionId)).toEqual([parent.id, child.id])
  expect(snapshot.artifacts).toEqual([
    { sessionId: child.id, parentSessionId: parent.id, path: join(root, 'absent.md'), available: false },
    { sessionId: child.id, parentSessionId: parent.id, path: root, description: 'directory', available: false },
  ])
  const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
  await ctx.mydot.presentResults(parent.id)
  expect(observe.mock.calls.every(([id]) => id === parent.id)).toBe(true)
})

it('normalizes referenced materials and artifacts and denies directories as editable text', async () => {
  const { ctx, root } = await setup()
  await mkdir(join(root, 'work'))
  const parent = await ctx.agentLoop.create(SessionId('normalized'), {}, { cwd: join(root, 'work') })
  await writeFile(join(root, 'artifact.md'), 'outside artifact')
  const space = await ctx.mydot.saveSpace({ ...spaceInput, materials: ['../material.md', '../unused.md'] })
  await ctx.mydot.attach(parent.id, space.id)
  parent.session.append('deliverables/presented', { turn: 0, callId: ToolCallId('declared'), files: [{ path: '../unused-artifact.md' }, { path: '../artifact.md' }] })
  expect(await ctx.mydot.readFile(parent.id, '../work/../artifact.md')).toMatchObject({ content: 'outside artifact', path: join(root, 'artifact.md') })
  await expect(ctx.mydot.readFile(parent.id, '.')).rejects.toThrow('regular text file')
  await expect(ctx.mydot.readFile(parent.id, '../private.md')).rejects.toThrow('Select a file referenced')
})

it('rechecks a watch revision changed during snapshot resolution and aborts before parking', async () => {
  const { ctx } = await setup()
  const original = ctx.mydot.snapshot.bind(ctx.mydot)
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  vi.spyOn(ctx.mydot, 'snapshot').mockImplementationOnce(async () => {
    const snapshot = await original()
    entered.resolve(undefined)
    await gate.promise
    return snapshot
  })
  const cancel = new AbortController()
  const watch = ctx.mydot.watch(cancel.signal)[Symbol.asyncIterator]()
  const first = watch.next()
  await entered.promise
  await ctx.mydot.saveSpace(spaceInput)
  gate.resolve(undefined)
  expect((await first).value?.spaces).toEqual([])
  expect((await watch.next()).value?.spaces).toHaveLength(1)
  cancel.abort()
  expect(await watch.next()).toEqual({ done: true, value: undefined })
})

it('serializes presentation retry after a rejected concurrent predecessor', async () => {
  const { ctx } = await setup()
  const parent = await ctx.agentLoop.create(SessionId('presentation-retry'), {})
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  const list = ctx.subagents.listChildren.bind(ctx.subagents)
  const spy = vi.spyOn(ctx.subagents, 'listChildren').mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await gate.promise
    throw new Error('temporary catalog failure')
  })
  const first = ctx.mydot.presentResults(parent.id)
  const rejected = expect(first).rejects.toThrow('temporary catalog failure')
  await entered.promise
  const second = ctx.mydot.presentResults(parent.id)
  spy.mockImplementation(list)
  gate.resolve(undefined)
  await rejected
  await second
  expect(spy).toHaveBeenCalledTimes(2)
})

it('rejects capture tools outside desktop admission and skips unrelated domain changes', async () => {
  const { ctx } = await setup()
  const { MyDotService } = await import('../src/index.ts')
  const invalid = new Context()
  contexts.push(invalid)
  expect(() => new MyDotService(invalid, { memoryDirectory: '/unused', maxTextBytes: 1, summaryCharacters: 1,
    desktopTools: [], captureTools: ['capture'] })).toThrow('subset')
  const snapshot = vi.spyOn(ctx.mydot, 'snapshot')
  const cancel = new AbortController()
  const watch = ctx.mydot.watch(cancel.signal)[Symbol.asyncIterator]()
  await watch.next()
  const next = watch.next()
  ctx.emit('domain/changed', { domain: 'unrelated', table: '', key: '', operation: 'deleted' })
  cancel.abort()
  expect(await next).toEqual({ done: true, value: undefined })
  expect(snapshot).toHaveBeenCalledOnce()
})

it('preserves rejected and cancelled pre-step decisions without injecting Space memory', async () => {
  const { ctx, root } = await setup()
  const parent = await ctx.agentLoop.create(SessionId('pre-step'), {}, { cwd: root })
  const space = await ctx.mydot.saveSpace(spaceInput)
  await ctx.mydot.attach(parent.id, space.id)
  const read = vi.spyOn(ctx.fs, 'readText')
  const rejected = { kind: 'reject' as const }
  expect(await agentEvents(ctx, parent).waterfall('agent/pre-step', { messages: [], turn: 1, step: 1, signal: signal() }, async () => rejected)).toBe(rejected)
  const cancel = new AbortController()
  const entered = { kind: 'enter' as const, messages: [message('original')] }
  const result = await agentEvents(ctx, parent).waterfall('agent/pre-step', { messages: [], turn: 1, step: 1, signal: cancel.signal }, async () => {
    cancel.abort()
    return entered
  })
  expect(result).toBe(entered)
  expect(read).not.toHaveBeenCalled()
})

it('uses header and deployment cwd fallbacks for snapshots and referenced-file access', async () => {
  const { ctx, root } = await setup()
  const header = ctx.sessions.create(SessionId('header-cwd'), { meta: { cwd: root } })
  const defaulted = ctx.sessions.create(SessionId('default-cwd'))
  const material = join(root, 'fallback.md')
  await writeFile(material, 'fallback text')
  const space = await ctx.mydot.saveSpace({ ...spaceInput, materials: [material] })
  await ctx.mydot.attach(header.id, space.id)
  await ctx.mydot.attach(defaulted.id, space.id)
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((id, options) => observe(id, options === undefined ? { projectionMode: 'none' } : options))
  const snapshot = await ctx.mydot.snapshot()
  expect(snapshot.conversations).toEqual([
    { sessionId: header.id, spaceId: space.id, cwd: root },
    { sessionId: defaulted.id, spaceId: space.id, cwd: ctx.workingDirectory.defaultDirectory },
  ])
  expect(await ctx.mydot.readFile(header.id, 'fallback.md')).toMatchObject({ content: 'fallback text' })
  expect(await ctx.mydot.readFile(defaulted.id, material)).toMatchObject({ content: 'fallback text' })
})

it('reports failed automatic result delivery and clears it only after a successful retry', async () => {
  const { ctx, root } = await setup()
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done'), textResponse('received')]))
  const parent = await ctx.agentLoop.create(SessionId('failed-delivery'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const notified = Promise.withResolvers<undefined>()
  vi.spyOn(ctx.logger, 'warn').mockImplementation(() => { notified.resolve(undefined) })
  const present = vi.spyOn(ctx.mydot, 'presentResults').mockRejectedValueOnce(new Error('parent inbox unavailable'))
  await ctx.mydot.startJob({ parentSessionId: parent.id, requestId: 'failure' as SessionRequestId,
    label: 'Delivery', prompt: 'work', provider: 'spawn' }, signal())
  await notified.promise
  expect((await ctx.mydot.snapshot()).issues).toEqual([{ sessionId: parent.id, kind: 'artifact-delivery' }])
  present.mockRestore()
  await ctx.mydot.presentResults(parent.id)
  expect((await ctx.mydot.snapshot()).issues).toEqual([])
  await ctx.subagents.waitForChildren(parent)
})

it('releases desktop ownership on child completion only after agent tool bodies settle', async () => {
  const { ctx, root } = await setup({ desktopTools: ['action'] })
  const parent = await ctx.agentLoop.create(SessionId('desktop-end'), {}, { cwd: root })
  const { SubagentRunId } = await import('@deepseek-ai/dsh-subagent')
  const info = { id: parent.id, runId: SubagentRunId('desktop-run'), provider: 'spawn', local: true, stopReason: 'completed' as const }
  const entered = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<undefined>()
  ctx.tools.register(defineContentToolFixture({ name: 'action', description: '', parameters: {}, async execute() {
    entered.resolve(undefined)
    await finished.promise
    return [{ type: 'text', text: 'finished' }]
  } }))
  const active = ctx.tools.execute({ name: 'action', arguments: {}, callId: ToolCallId('desktop-end'), signal: signal(), agent: parent })
  await entered.promise
  ctx.emit('subagent/end', info)
  expect((await ctx.mydot.snapshot()).desktop).toMatchObject({ phase: 'agent', owner: parent.id, inFlight: 1 })
  finished.resolve(undefined)
  await active
  ctx.emit('subagent/end', info)
  expect((await ctx.mydot.snapshot()).desktop).toEqual({ phase: 'free', inFlight: 0 })
  await ctx.tools.execute({ name: 'action', arguments: {}, callId: ToolCallId('desktop-human'), signal: signal(), agent: parent })
  ctx.mydot.handoffDesktop()
  ctx.emit('subagent/end', info)
  expect((await ctx.mydot.snapshot()).desktop.phase).toBe('human')
})
