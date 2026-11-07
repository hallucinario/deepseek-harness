/** Keyless Loader composition with real loop, child Sessions, filesystem and storage. */
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup(existing?: { root: string; pool: MemoryMediaPool }) {
  const root = existing?.root ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-mydot-loader-')))
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await liveConfig(ctx, SubagentRuntime, {})
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(Storage)
  const pool = existing?.pool ?? new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('memory', backend))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  ctx.provide('storageDomain', facility)
  ctx.effect(() => async () => { await facility.closeAll(); await backend.close() })
  // These scenarios use existing live Sessions; conversation creation is owned
  // by SessionController and is not replaced with a simulated implementation.
  ctx.provide('sessionController', {} as never)
  const file = join(root, 'cordis.yml')
  await writeFile(file, `- name: '@deepseek-ai/dsh-experimental-mydot'\n  config:\n    memoryDirectory: '${root}/memory'\n`)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.loader.builtins.include = Include
  ctx.loader.internal = undefined
  const row = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { ctx, root, row, pool }
}

it('loads opt-in, records scoped memory on the first child request, and authorizes relative files against the original cwd', async () => {
  const { ctx, root } = await setup()
  const adapter = new MockAdapter([textResponse('parent ready'), textResponse('child done'), textResponse('received')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await parent.whenIdle()
  const space = await ctx.mydot.saveSpace({ name: 'Research', purpose: 'Summarize the supplied report', instructions: 'Cite report.md', materials: ['report.md'] })
  await ctx.mydot.attach(parent.id, space.id)
  await ctx.mydot.saveMemory({ kind: 'personal' }, { content: 'Personal premise', version: null })
  await ctx.mydot.saveMemory({ kind: 'space', spaceId: space.id }, { content: 'Scoped decision', version: null })
  const other = await ctx.mydot.saveSpace({ name: 'Other', purpose: '', instructions: '', materials: [] })
  await ctx.mydot.saveMemory({ kind: 'space', spaceId: other.id }, { content: 'Unrelated secret', version: null })
  await writeFile(join(root, 'report.md'), 'original report')
  const read = await ctx.mydot.readFile(parent.id, 'report.md')
  expect(read).toMatchObject({ kind: 'text', path: join(root, 'report.md'), content: 'original report' })
  const accepted = await ctx.mydot.startJob({ parentSessionId: parent.id, requestId: 'job-a' as SessionRequestId, label: 'A', prompt: 'Analyze report.md', provider: 'spawn' }, new AbortController().signal)
  await ctx.subagents.waitForChildren(parent)
  const childRequest = JSON.stringify(adapter.requests[1]?.messages)
  expect(childRequest).toContain('Summarize the supplied report')
  expect(childRequest).toContain('Personal premise')
  expect(childRequest).toContain('Scoped decision')
  expect(childRequest).not.toContain('Unrelated secret')
  using observed = await ctx.sessionQuery.observeSession(accepted.childSessionId)
  expect(JSON.stringify(observed.events)).toContain('Scoped decision')
  const same = await ctx.mydot.startJob({ parentSessionId: parent.id, requestId: 'job-a' as SessionRequestId, label: 'A', prompt: 'Analyze report.md', provider: 'spawn' }, new AbortController().signal)
  expect(same).toEqual(accepted)
  expect((await ctx.mydot.snapshot()).jobs).toMatchObject([{ parentSessionId: parent.id, childSessionId: accepted.childSessionId }])
})

it('rejects a reused start identity with different input instead of starting or silently relabelling a child', async () => {
  const { ctx } = await setup()
  const adapter = new MockAdapter([textResponse('done'), textResponse('noted')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  const request = { parentSessionId: parent.id, requestId: 'stable' as SessionRequestId, label: 'A', prompt: 'original', provider: 'spawn' as const }
  await ctx.mydot.startJob(request, new AbortController().signal)
  await ctx.subagents.waitForChildren(parent)
  await expect(ctx.mydot.startJob({ ...request, prompt: 'replacement' }, new AbortController().signal)).rejects.toThrow('different')
})

it('runs two independent children, presents both current files to the parent inbox, and retains missing declarations', async () => {
  const { ctx, root } = await setup()
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const { toolCallResponse } = await import('../../../core/agent-loop/tests/mock-adapter.ts')
  const { defineContentToolFixture } = await import('@deepseek-ai/dsh-tools')
  const Present = await import('@deepseek-ai/dsh-tool-present')
  await ctx.plugin(Present, { maxFiles: 4 })
  ctx.tools.register(defineContentToolFixture({
    name: 'report', description: 'Write a report in this test execution directory', parameters: { file: { type: 'string' } },
    async execute(args) {
      if (args.file === undefined) throw new Error('report filename is required')
      await writeFile(join(root, args.file), `report ${args.file}`)
      return [{ type: 'text', text: args.file }]
    },
  }))
  const counts = new Map<string, number>()
  ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
    async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions) {
      const id = options.sessionId ?? ''
      const turn = counts.get(id) ?? 0
      counts.set(id, turn + 1)
      const file = id === 'mydot-a' ? 'A.md' : 'B.md'
      if (id === 'mydot-a' || id === 'mydot-b') {
        yield* (turn === 0 ? toolCallResponse(`${id}-write`, 'report', { file })
          : turn === 1 ? toolCallResponse(`${id}-present`, 'present', { files: [{ path: file }] }) : textResponse('Declared file'))
      } else yield* textResponse('Parent remains available')
    }
  }())
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const space = await ctx.mydot.saveSpace({ name: 'Research', purpose: '', instructions: '', materials: [] })
  await ctx.mydot.attach(parent.id, space.id)
  await Promise.all(['a', 'b'].map(id => ctx.mydot.startJob({ parentSessionId: parent.id, requestId: id as SessionRequestId,
    label: id, prompt: `Write ${id}`, provider: 'spawn' }, new AbortController().signal)))
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Can we keep talking?' }], source: { kind: 'user' } }))
  await ctx.subagents.waitForChildren(parent)
  await ctx.mydot.presentResults(parent.id)
  await parent.whenIdle()
  const snapshot = await ctx.mydot.snapshot()
  expect(snapshot.artifacts).toEqual(expect.arrayContaining(['A.md', 'B.md'].map(file => expect.objectContaining({
    parentSessionId: parent.id, path: join(root, file), available: true,
  }))))
  using parentSource = await ctx.sessionQuery.observeSession(parent.id)
  const messages = parentSource.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'mydot'
    && event.data.source.sections.some(section => section.name.startsWith('mydot/artifacts/')))
  expect(messages).toHaveLength(2)
  await ctx.mydot.presentResults(parent.id)
  expect(parent.inbox.nextTurn).toHaveLength(0)
  const current = await ctx.mydot.readFile(SessionId('mydot-a'), 'A.md')
  expect(current).toMatchObject({ kind: 'text', content: 'report A.md' })
  // A declaration is a live file reference; moving its source keeps the saved declaration visible.
  const { rename } = await import('node:fs/promises')
  await rename(join(root, 'A.md'), join(root, 'A.md.tobedeleted'))
  expect((await ctx.mydot.snapshot()).artifacts.find(file => file.path === join(root, 'A.md'))?.available).toBe(false)
})

it('steers A exactly once during generation, keeps parent conversation available, and stops A while B continues', async () => {
  const { ctx, root } = await setup()
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const aStarted = Promise.withResolvers<undefined>()
  const aSteered = Promise.withResolvers<undefined>()
  const bStarted = Promise.withResolvers<undefined>()
  const parentAnswered = Promise.withResolvers<undefined>()
  const aScript = new MockAdapter(['hang', 'hang'])
  const bScript = new MockAdapter(['hang'])
  ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
    async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions) {
      if (options.sessionId === 'mydot-a') {
        if (aScript.requests.length === 0) aStarted.resolve(undefined); else aSteered.resolve(undefined)
        yield* aScript.stream(options)
      } else if (options.sessionId === 'mydot-b') {
        bStarted.resolve(undefined)
        yield* bScript.stream(options)
      } else {
        yield* textResponse('Yes, we can keep talking')
        parentAnswered.resolve(undefined)
      }
    }
  }())
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const space = await ctx.mydot.saveSpace({ name: 'Parallel', purpose: '', instructions: '', materials: [] })
  await ctx.mydot.attach(parent.id, space.id)
  await Promise.all(['a', 'b'].map(id => ctx.mydot.startJob({ parentSessionId: parent.id, requestId: id as SessionRequestId,
    label: id, prompt: `Work on ${id}`, provider: 'spawn' }, new AbortController().signal)))
  await Promise.all([aStarted.promise, bStarted.promise])
  const a = ctx.agents.get(SessionId('mydot-a'))!
  const b = ctx.agents.get(SessionId('mydot-b'))!
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Keep talking' }], source: { kind: 'user' } }))
  await parentAnswered.promise
  const input = { parentSessionId: parent.id, childSessionId: a.id, requestId: 'steer-a' as SessionRequestId, delivery: 'steer' as const, text: 'Change only A' }
  const receipts = await Promise.all([
    ctx.mydot.send(input, new AbortController().signal), ctx.mydot.send(input, new AbortController().signal),
  ])
  expect(receipts[0]).toEqual(receipts[1])
  await aSteered.promise
  using source = await ctx.sessionQuery.observeSession(a.id)
  expect(source.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === input.requestId)).toHaveLength(1)
  expect(JSON.stringify(aScript.requests[1]?.messages)).toContain('Change only A')
  expect(JSON.stringify(bScript.requests)).not.toContain('Change only A')
  expect(ctx.mydot.stop({ parentSessionId: parent.id, childSessionId: a.id })).toEqual({ accepted: true })
  await a.whenIdle()
  expect(b.status).toBe('running')
  expect((await ctx.mydot.snapshot()).jobs.find(job => job.childSessionId === b.id)?.status).toBe('running')
  ctx.mydot.stop({ parentSessionId: parent.id, childSessionId: b.id })
  await b.whenIdle()
  await ctx.subagents.waitForChildren(parent)
})

it('restores Space and memory after Host restart and unloads/reloads without duplicate context providers', async () => {
  const first = await setup()
  const parent = await first.ctx.agentLoop.create(SessionId('original'), {})
  const space = await first.ctx.mydot.saveSpace({ name: 'Durable', purpose: 'One scoped instruction', instructions: '', materials: [] })
  await first.ctx.mydot.attach(parent.id, space.id)
  await first.ctx.mydot.saveMemory({ kind: 'personal' }, { version: null, content: 'Persistent personal premise' })
  await first.ctx.mydot.saveMemory({ kind: 'space', spaceId: space.id }, { version: null, content: 'Persistent Space decision' })
  await first.ctx.fiber.dispose()
  const second = await setup(first)
  expect(await second.ctx.mydot.readMemory({ kind: 'personal' })).toMatchObject({ content: 'Persistent personal premise' })
  expect(await second.ctx.mydot.readMemory({ kind: 'space', spaceId: space.id })).toMatchObject({ content: 'Persistent Space decision' })
  expect((await second.ctx.mydot.snapshot()).spaces).toEqual([space])
  const entry = [...second.ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-experimental-mydot')!
  const retiring = entry.fiber!
  await entry.update({ disabled: true })
  await retiring.dispose()
  expect(second.ctx.get('mydot')).toBeUndefined()
  await entry.update({ disabled: false })
  await entry.fiber!.await()
  expect((await second.ctx.mydot.snapshot()).spaces).toEqual([space])
  const adapter = new MockAdapter([textResponse('remembered')])
  second.ctx.llm.registerAdapter(['mock'], adapter)
  const fresh = await second.ctx.agentLoop.create(SessionId('fresh'), { provider: 'mock', model: 'mock' })
  await second.ctx.mydot.attach(fresh.id, space.id)
  fresh.followup(createUserMessage({ content: [{ type: 'text', text: 'Use my memory' }], source: { kind: 'user' } }))
  await fresh.whenIdle()
  using observed = await second.ctx.sessionQuery.observeSession(fresh.id)
  expect(observed.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'mydot')).toHaveLength(1)
  expect(JSON.stringify(adapter.requests)).toContain('Persistent Space decision')
})
