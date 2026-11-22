/** Keyless Loader composition with real loop, child Sessions, filesystem and storage. */
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join, posix, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { appendPluginRecord, pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { capsAttemptRefs } from '../src/caps-tools.ts'
import '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup(
  existing?: { root: string; pool: MemoryMediaPool }, policy?: { mode: SandboxMode; workspaceRoot: string },
  config: Record<string, unknown> = {}, persist = true,
) {
  const root = existing?.root ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-mydot-loader-')))
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: policy === undefined })
  await ctx.plugin(SandboxPolicy, policy ?? { mode: 'workspace-write', workspaceRoot: root })
  if (policy !== undefined) {
    await ctx.plugin(SandboxedFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectory)
  }
  if (persist) await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
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
  await writeFile(file, JSON.stringify([{ name: '@deepseek-ai/dsh-experimental-mydot', config: { memoryDirectory: join(root, 'memory'), ...config } }]))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.loader.builtins.include = Include
  ctx.loader.internal = undefined
  const row = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { ctx, root, row, pool }
}

it('owns the optional Caps tool registration through Loader disposal', async ({ onTestFinished }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mydot-caps-loader-')))
  onTestFinished(async () => { await rename(root, root + '.tobedeleted') })
  const workspace = join(root, 'work')
  await mkdir(workspace)
  const { ctx } = await setup({ root, pool: new MemoryMediaPool() }, undefined, {
    caps: { launcher: process.execPath, workspaceRoots: [workspace], timeoutMs: 5_000 },
  })
  const toolNames = () => ctx.tools.schemas().map(tool => tool.name)
  expect(toolNames()).toContain('caps_compile_document_bundle')
  const configured = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-experimental-mydot')!
  const retiring = configured.fiber!
  await configured.update({ disabled: true })
  await retiring.dispose()
  expect(toolNames()).not.toContain('caps_compile_document_bundle')
})

it('edits only the configured memory root and historical conversation workspace under the actual file sandbox', async ({ onTestFinished }) => {
  const root = await realpath(await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-mydot-policy-')))
  assertWorkspaceOutsideTemp(root)
  onTestFinished(async () => { await rename(root, root + '.tobedeleted') })
  const fallback = join(root, 'fallback')
  const workspace = join(root, 'work')
  await mkdir(fallback)
  await mkdir(workspace)
  const { ctx } = await setup({ root, pool: new MemoryMediaPool() }, { mode: 'workspace-write', workspaceRoot: fallback })
  const parent = await ctx.agentLoop.create(SessionId('policy-parent'), {}, { cwd: workspace })
  const space = await ctx.mydot.saveSpace({ name: 'Policy', purpose: '', instructions: '', materials: [] })
  await ctx.mydot.attach(parent.id, space.id)
  expect(await ctx.mydot.saveMemory({ kind: 'personal' }, { version: null, content: 'Personal premise' })).toMatchObject({ kind: 'saved' })
  expect(await ctx.mydot.saveMemory({ kind: 'space', spaceId: space.id }, { version: null, content: 'Scoped decision' })).toMatchObject({ kind: 'saved' })
  await ctx.plugin({
    name: 'mydot-editor-caller', inject: ['mydot'],
    async apply(caller) {
      expect(await caller.mydot.saveFile(parent.id, { path: 'report.md', version: null, content: 'Report' })).toMatchObject({ kind: 'saved' })
    },
  })
  setSandboxMode(parent.session, 'read-only')
  const current = await ctx.mydot.readFile(parent.id, 'report.md')
  if (current.kind !== 'text') throw new Error('Missing report')
  await expect(ctx.mydot.saveFile(parent.id, { path: 'report.md', version: current.version, content: 'Denied' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(await readFile(join(workspace, 'report.md'), 'utf8')).toBe('Report')
  const unrelated = await ctx.fs.resolve(join(root, 'private.md'))
  await expect(ctx.fs.writeText(unrelated, 'No ambient grant')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  const memory = join(root, 'memory', 'MEMORY.md')
  await rename(memory, memory + '.original')
  const secret = join(root, 'private.md')
  await writeFile(secret, 'Keep unchanged')
  await symlink(secret, memory)
  const linked = await ctx.mydot.readMemory({ kind: 'personal' })
  if (linked.kind !== 'text') throw new Error('Missing linked memory')
  await expect(ctx.mydot.saveMemory({ kind: 'personal' }, { version: linked.version, content: 'Denied escape' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(await readFile(secret, 'utf8')).toBe('Keep unchanged')
  await ctx.fiber.dispose()
  const cold = await setup({ root, pool: new MemoryMediaPool() }, { mode: 'workspace-write', workspaceRoot: fallback })
  expect(cold.ctx.agents.get(parent.id)).toBeUndefined()
  await expect(cold.ctx.mydot.saveFile(parent.id, { path: 'report.md', version: current.version, content: 'Denied after restart' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
})

it('keeps a read-only deployment read-only when the configured memory root is outside its fallback', async ({ onTestFinished }) => {
  const root = await realpath(await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-mydot-readonly-')))
  assertWorkspaceOutsideTemp(root)
  onTestFinished(async () => { await rename(root, root + '.tobedeleted') })
  const { ctx } = await setup({ root, pool: new MemoryMediaPool() }, { mode: 'read-only', workspaceRoot: root })
  await expect(ctx.mydot.saveMemory({ kind: 'personal' }, { version: null, content: 'Denied' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
})

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
  for (const file of ['A.md', 'B.md']) expect(snapshot.artifacts.some(item =>
    item.parentSessionId === parent.id && item.path === join(root, file) && item.available)).toBe(true)
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

async function setupCaps(onTestFinished: (fn: () => Promise<void>) => void, options?: { maxTextBytes?: number; persist?: boolean }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mydot-caps-')))
  const workspace = join(root, 'work')
  await mkdir(workspace)
  await writeFile(join(workspace, 'guide.md'), '# Public guide\n\nRead this guide.\n')
  onTestFinished(async () => { await rename(root, root + '.tobedeleted') })
  const windows = process.platform === 'win32'
  const launcher = join(root, windows ? 'caps-fixture.cmd' : 'caps-fixture')
  const fixture = fileURLToPath(new URL('./fixtures/caps-server.ts', import.meta.url))
  const quoted = windows ? (value: string) => '"' + value.replaceAll('%', '%%') + '"'
    : (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const command = [process.execPath, '--import', import.meta.resolve('tsx/esm'), fixture].map(quoted).join(' ')
  // The SDK uses cross-spawn, which launches .cmd files through the native Windows command processor.
  const script = windows ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' + command + ' %*\r\n'
    : '#!/bin/sh\nexec ' + command + ' "$@"\n'
  await writeFile(launcher, script)
  await chmod(launcher, windows ? 0o444 : 0o500)
  const config = {
    caps: { launcher, workspaceRoots: [workspace], timeoutMs: 5_000 },
    ...(options?.maxTextBytes === undefined ? {} : { maxTextBytes: options.maxTextBytes }),
  }
  const environment = await setup({ root, pool: new MemoryMediaPool() }, undefined, config, options?.persist)
  const space = await environment.ctx.mydot.saveSpace({ name: 'Guide', purpose: 'Compile the public guide', instructions: '', materials: ['guide.md'] })
  return { ...environment, workspace, space, launcher, config }
}

it('binds a native Caps attempt and its output to a durable MyDot Session through stdio', async ({ onTestFinished }) => {
  const { ctx, workspace, space } = await setupCaps(onTestFinished)
  const bundle = { name: 'bundle', documents: [{ source: 'guide.md' }] }
  const toolName = 'caps_compile_document_bundle'
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('first', toolName, bundle), toolCallResponse('again', toolName, bundle), textResponse('Compiled'),
  ]))
  const agent = await ctx.agentLoop.create(SessionId('caps-bundle'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  await ctx.mydot.attach(agent.id, space.id)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Compile guide.md' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)

  const calls = (await readFile(join(workspace, 'calls.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as {
    phase: string
    spaceId?: string
    version?: string
    sessionRef?: string
    taskRef?: string
    executionRef?: string
    requestId: string
  })
  const first = calls[0]
  if (first === undefined) throw new Error('Caps launcher recorded no dispatch')
  const { requestId } = first
  expect(first).toMatchObject({ phase: 'check', spaceId: space.id })
  expect(first.version).toMatch(/^\d+\.\d+\.\d+/u)
  expect(first.sessionRef).toMatch(/^dsh-session-/u)
  expect(first.taskRef).toMatch(/^dsh-task-/u)
  expect(first.executionRef).toMatch(/^dsh-run-/u)
  expect(calls.slice(1)).toEqual([{ phase: 'invoke', requestId }])
  using observed = await ctx.sessionQuery.observeSession(agent.id)
  const results = observed.events.filter(event => event.type === 'tool/result')
  expect(results.map(event => event.data.meta)).toEqual([
    expect.objectContaining({ status: 'succeeded', installedVersion: '0.4.1', invocationId: 'inv-stdio-fixture',
      receiptVerification: 'not_verified', recordingStatus: 'ok', usageRecording: 'ok', handoff: 'verified',
      requestId }),
    expect.objectContaining({ status: 'not_dispatched', requestId }),
  ])
  const documents = observed.events.filter(event => event.type === 'deliverables/presented')
  expect(documents).toHaveLength(1)
  const paths = documents[0]?.data.files.map(file => file.path) ?? []
  const compiledPath = posix.join('docs', 'guide.md')
  expect(paths.map(path => path.split(sep).slice(-2).join('/'))).toEqual(['bundle/manifest.json', compiledPath])
  const artifact = paths.find(path => path.endsWith(sep + join('docs', 'guide.md')))
  if (artifact === undefined) throw new Error('Missing receipt-matched delivery')
  expect(await ctx.mydot.readFile(agent.id, artifact)).toMatchObject({ kind: 'text', content: '# Public guide\n\nRead this guide.\n' })
})

it('projects one authorized durable attempt to the Foundry intake contract across a restart', async ({ onTestFinished }) => {
  const first = await setupCaps(onTestFinished)
  const { ctx, space, workspace } = first
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('run-caps', 'caps_compile_document_bundle', { name: 'bundle', documents: [{ source: 'guide.md' }] }),
    textResponse('response excluded from observation'),
  ]))
  const agent = await ctx.agentLoop.create(SessionId('observe-caps'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  await ctx.mydot.attach(agent.id, space.id)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'request excluded from observation' }],
    source: { kind: 'user', rpcId: 'chosen-request' as SessionRequestId },
  }))
  await agent.whenIdle()
  expect(await ctx.sessions.flush(agent.session)).toBe(true)
  using recorded = await ctx.sessionQuery.observeSession(agent.id)
  const opened = recorded.events.find(event => event.type === 'turn/start')!
  const ended = recorded.events.find(event => event.type === 'turn/end')!
  const request = recorded.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')!
  const result = recorded.events.find(event => event.type === 'tool/result')!
  const file = recorded.events.find(event => event.type === 'deliverables/presented')!.data.files
    .find(item => basename(item.path) === 'guide.md')!
  const content = await readFile(file.path)
  const selection = {
    projectId: 'bound-project', spaceId: space.id, sessionId: agent.id, requestSequence: request.seq,
    firstSequence: opened.seq, lastSequence: ended.seq,
    artifacts: [{
      path: file.path, sourceRef: 'approved-guide', version: '1', artifactType: 'MARKDOWN_DOCUMENT' as const,
      contentDigest: createHash('sha256').update(content).digest('hex'),
    }],
  }
  const projected = await ctx.mydot.projectFoundryObservation(selection)
  expect(remoteMethods(ctx.mydot).map(marker => marker.method)).not.toContain('projectFoundryObservation')
  const caps = result.data.meta as { sessionRef: string; taskRef: string; executionRef: string; runtimeVersion: string }
  expect(projected).toMatchObject({
    hccScope: { sessionRef: caps.sessionRef, taskRef: caps.taskRef, executionRef: caps.executionRef },
    observation: {
      identity: { projectId: 'bound-project', requestId: 'chosen-request', sessionId: agent.id, attemptId: caps.executionRef },
      runtimeVersion: caps.runtimeVersion, status: 'SUCCEEDED', context: null,
      observedAt: new Date(ended.time).toISOString(), eventRange: { firstSequence: opened.seq, lastSequence: ended.seq },
      artifacts: [{ sourceRef: 'approved-guide', version: '1', artifactType: 'MARKDOWN_DOCUMENT', content: new Uint8Array(content) }],
    },
  })
  expect(projected.observation.runtimeVersion).toMatch(/^\d+\.\d+\.\d+/u)
  expect(projected.observation.events.find(event => event.sequence === result.seq)).toMatchObject({
    type: 'TOOL_CALL_END', payload: { invocationId: 'inv-stdio-fixture', executionRef: caps.executionRef },
  })
  expect(projected.observation.events.find(event => event.type === 'MODEL_CALL_END')?.payload)
    .toMatchObject({ modelId: 'mock', providerId: 'mock', inputTokens: 10, outputTokens: 5 })
  expect(JSON.stringify(projected)).not.toMatch(/request excluded|response excluded|guide\.md/u)
  expect(await readFile(join(workspace, 'calls.jsonl'), 'utf8')).toMatch(/"phase":"invoke"/u)
  await ctx.fiber.dispose()
  const cold = await setup(first, undefined, first.config)
  expect(await cold.ctx.mydot.projectFoundryObservation(selection)).toEqual(projected)
  const wrongSpace = await cold.ctx.mydot.saveSpace({ name: 'Other', purpose: '', instructions: '', materials: [] })
  await expect(cold.ctx.mydot.projectFoundryObservation({ ...selection, spaceId: wrongSpace.id })).rejects.toThrow('approved Space')
  await expect(cold.ctx.mydot.projectFoundryObservation({ ...selection, lastSequence: ended.seq + 1 })).rejects.toThrow('durable closed turn')
  await expect(cold.ctx.mydot.projectFoundryObservation({ ...selection, lastSequence: Number.MAX_SAFE_INTEGER }))
    .rejects.toThrow('Invalid Foundry observation selection')
  await expect(cold.ctx.mydot.projectFoundryObservation({ ...selection, requestSequence: request.seq + 1 })).rejects.toThrow('single recorded input')
  const approved = selection.artifacts[0]!
  await expect(cold.ctx.mydot.projectFoundryObservation({
    ...selection, artifacts: [{ ...approved, path: join(workspace, 'guide.md') }],
  })).rejects.toThrow('was not presented by this attempt')
  await expect(cold.ctx.mydot.projectFoundryObservation({
    ...selection, artifacts: [{ ...approved, path: join(first.root, 'outside.md') }],
  })).rejects.toThrow('inside the recorded workspace')
  await expect(cold.ctx.mydot.projectFoundryObservation({
    ...selection, artifacts: [{ ...approved, contentDigest: '0'.repeat(64) }],
  })).rejects.toThrow('did not match the recorded handoff')
  await expect(cold.ctx.mydot.projectFoundryObservation({
    ...selection, artifacts: [approved, approved],
  })).rejects.toThrow('Duplicate artifact')
  await writeFile(file.path, 'Changed after the receipt')
  await expect(cold.ctx.mydot.projectFoundryObservation(selection)).rejects.toThrow('digest verification')
  expect((await cold.ctx.mydot.projectFoundryObservation({ ...selection, artifacts: [] })).observation.artifacts).toEqual([])
  expect((await readFile(join(workspace, 'calls.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
})

it('preserves a dispatched Caps attempt when the real ToolRegistry cancels its result', async ({ onTestFinished }) => {
  const first = await setupCaps(onTestFinished)
  const { ctx, space, workspace } = first
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('cancel-after-dispatch', 'caps_compile_document_bundle', { name: 'abort-invoke', documents: [{ source: 'guide.md' }] }),
  ]))
  const agent = await ctx.agentLoop.create(SessionId('caps-after-dispatch'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  await ctx.mydot.attach(agent.id, space.id)
  const beforeDispatch = Promise.withResolvers<undefined>()
  const allowDispatch = Promise.withResolvers<undefined>()
  const received = Promise.withResolvers<undefined>()
  const watcher = watch(workspace, (_event, filename) => { if (filename === 'invoke-ready') received.resolve(undefined) })
  ctx.on('session/flush', async (session) => {
    if (session !== agent.session || !session.snapshotEvents().some(event => pluginRecordOf(event)?.type === 'plugin:mydot/caps-dispatch')) return
    beforeDispatch.resolve(undefined)
    await allowDispatch.promise
  })
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Compile a public guide' }], source: { kind: 'user' },
    }))
    await beforeDispatch.promise
    expect((await readFile(join(workspace, 'calls.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    allowDispatch.resolve(undefined)
    await received.promise
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
  } finally {
    allowDispatch.resolve(undefined)
    watcher.close()
  }
  using recorded = await ctx.sessionQuery.observeSession(agent.id)
  const result = recorded.events.find(event => event.type === 'tool/result')
  expect(result?.data.error?.code).toBe('ABORTED')
  expect(result?.data.meta).toBeUndefined()
  const opened = recorded.events.find(event => event.type === 'turn/start')!
  const ended = recorded.events.find(event => event.type === 'turn/end')!
  const request = recorded.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')!
  expect(ended.data.reason.kind).toBe('aborted')
  const selection = {
    projectId: 'bound-project', spaceId: space.id, sessionId: agent.id,
    firstSequence: opened.seq, lastSequence: ended.seq, requestSequence: request.seq, artifacts: [],
  }
  const [check, invoke] = (await readFile(join(workspace, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
    phase: string
    requestId: string
    sessionRef: string
    taskRef: string
    executionRef: string
    version: string
  })
  expect(invoke).toEqual({ phase: 'invoke', requestId: check!.requestId })
  const { sessionRef, taskRef, executionRef, requestId, version } = check!
  const projected = await ctx.mydot.projectFoundryObservation(selection)
  expect(projected.hccScope).toEqual({ sessionRef, taskRef, executionRef })
  expect(projected.observation).toMatchObject({ status: 'UNKNOWN', runtimeVersion: version, artifacts: [] })
  expect(projected.observation.events.find(event => event.payload.requestId === requestId)?.payload).toMatchObject({
    status: 'unknown', requestId, sessionRef, taskRef, executionRef,
    executionFingerprint: 'sha256:' + createHash('sha256').update('fixture-fingerprint').digest('hex'),
  })
  await ctx.fiber.dispose()
  const cold = await setup(first, undefined, first.config)
  expect(await cold.ctx.mydot.projectFoundryObservation(selection)).toEqual(projected)
  expect((await readFile(join(workspace, 'calls.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
})

it('stops before Caps invoke when the dispatch checkpoint cannot be confirmed', async ({ onTestFinished }) => {
  const { ctx, space, workspace } = await setupCaps(onTestFinished)
  const agent = await ctx.agentLoop.create(SessionId('caps-no-dispatch-checkpoint'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  await ctx.mydot.attach(agent.id, space.id)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('checkpoint-lost', 'caps_compile_document_bundle', { name: 'bundle', documents: [{ source: 'guide.md' }] }),
    textResponse('Stopped'),
  ]))
  const checkpoint = ctx.sessions.flush.bind(ctx.sessions)
  let refused = false
  const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (!refused && session === agent.session
      && session.snapshotEvents().some(event => pluginRecordOf(event)?.type === 'plugin:mydot/caps-dispatch')) {
      refused = true
      return false
    }
    return checkpoint(session)
  })
  onTestFinished(() => { flush.mockRestore() })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Compile a public guide' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  using recorded = await ctx.sessionQuery.observeSession(agent.id)
  expect(recorded.events.find(event => event.type === 'tool/result')?.data.meta).toMatchObject({ status: 'not_dispatched' })
  const preflight = (await readFile(join(workspace, 'calls.jsonl'), 'utf8')).trim()
  expect(preflight.split('\n')).toHaveLength(1)
  expect(preflight).toContain('"phase":"check"')
})

it('reads an unsettled Caps intent after recovery and ignores records from different calls', async ({ onTestFinished }) => {
  const { ctx, space, workspace } = await setupCaps(onTestFinished)
  const session = ctx.sessions.create(SessionId('caps-unsettled-intent'), { meta: { cwd: workspace } })
  await ctx.mydot.attach(session.id, space.id)
  const start = session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const input = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Recover the public document attempt' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const callId = ToolCallId('first')
  const name = 'caps_compile_document_bundle'
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'mock', model: 'mock' }, content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
    }),
  }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
  const refs = capsAttemptRefs(session.id, start.seq)
  const binding = {
    ...refs, runtimeVersion: '1.2.3', installedVersion: '0.4.1',
    executionFingerprint: 'sha256:' + 'a'.repeat(64), authorityDigest: 'sha256:' + 'b'.repeat(64),
  }
  const foreign = { ...refs, status: 'succeeded', handoff: 'verified' }
  appendPluginRecord(session, 'plugin:mydot/caps-settlement', { dispatchSequence: call.seq, observation: foreign })
  appendPluginRecord(session, 'plugin:mydot/caps-dispatch', { ...binding, callSequence: input.seq })
  const dispatchSequence = appendPluginRecord(session, 'plugin:mydot/caps-dispatch', { ...binding, callSequence: call.seq })
  appendPluginRecord(session, 'plugin:mydot/caps-settlement', {
    dispatchSequence, observation: { ...foreign, executionRef: 'foreign-execution' },
  })
  session.append('tool/result', {
    turn: 1, step: 1, message: createToolResultMessage({
      callId, isError: true, content: [{ type: 'text', text: 'Interrupted' }],
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  const end = session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  await using writer = await ctx.sessionPersistence.create(session.header)
  await writer.append(session.snapshotEvents())
  await writer.flush()
  const result = await ctx.mydot.projectFoundryObservation({
    projectId: 'bound-project', spaceId: space.id, sessionId: session.id, firstSequence: start.seq, lastSequence: end.seq,
    requestSequence: input.seq, artifacts: [],
  })
  expect(result.observation.status).toBe('UNKNOWN')
  expect(result.observation.events.find(event => event.sequence === dispatchSequence)).toMatchObject({
    type: 'CAPTURE_DEGRADED', payload: { ...binding, status: 'unknown' },
  })
  expect(result.hccScope?.executionRef).toBe(refs.executionRef)
  await expect(readFile(join(workspace, 'calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('requires a real terminal boundary before projecting an otherwise admissible persisted input', async ({ onTestFinished }) => {
  const { ctx, space, workspace } = await setupCaps(onTestFinished)
  const agent = await ctx.agentLoop.create(SessionId('observation-open-turn'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  await ctx.mydot.attach(agent.id, space.id)
  const start = agent.session.append('turn/start', { turn: 1 })
  const request = agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'actual persisted request' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const selection = {
    projectId: 'bound-project', spaceId: space.id, sessionId: agent.id,
    firstSequence: start.seq, requestSequence: request.seq, lastSequence: request.seq + 1, artifacts: [],
  }
  const caller = new AbortController()
  const remote = ctx.extend({ invocation: {
    request: { namespace: 'mydot', method: 'projectFoundryObservation', args: {} },
    service: 'mydot', peer: new Peer(ctx, { principal: { kind: 'owner' } }), signal: caller.signal,
    uplink: <T>(): AsyncIterable<T> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  } })
  await expect(remote.mydot.projectFoundryObservation(selection)).rejects.toThrow('requires a trusted Host caller')
  await expect(ctx.mydot.projectFoundryObservation(selection)).rejects.toThrow('durable closed turn')
  const ended = agent.session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  expect(ended.seq).toBe(selection.lastSequence)
  const projected = await ctx.mydot.projectFoundryObservation(selection, caller.signal)
  expect(projected).toMatchObject({
    hccScope: null, observation: {
      identity: { requestId: request.data.id }, runtimeVersion: null, status: 'UNKNOWN',
      events: [{ type: 'RUN_STATE_TRANSITION' }, { type: 'RUN_STATE_TRANSITION', payload: { state: 'UNKNOWN', reason: 'interrupted' } }],
    },
  })
  const second = agent.session.append('turn/start', { turn: 2 })
  const secondInput = agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'later request' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const cancelled = agent.session.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  const later = await ctx.mydot.projectFoundryObservation({
    ...selection, firstSequence: second.seq, requestSequence: secondInput.seq, lastSequence: cancelled.seq,
  })
  expect(later.observation.status).toBe('CANCELLED')
  expect(later.observation.identity.attemptId).not.toBe(projected.observation.identity.attemptId)
  caller.abort(new Error('Host read cancelled'))
  await expect(ctx.mydot.projectFoundryObservation(selection, caller.signal)).rejects.toThrow('Host read cancelled')
})

it('refuses unpersisted Sessions before and after the persistence service is enabled', async ({ onTestFinished }) => {
  const { ctx, root, space, workspace } = await setupCaps(onTestFinished, { persist: false })
  const agent = await ctx.agentLoop.create(SessionId('observation-not-stored'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  await ctx.mydot.attach(agent.id, space.id)
  const selection = {
    projectId: 'bound-project', spaceId: space.id, sessionId: agent.id, firstSequence: 0, requestSequence: 1, lastSequence: 2, artifacts: [],
  }
  await expect(ctx.mydot.projectFoundryObservation(selection)).rejects.toThrow('requires durable Session storage')
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'late-sessions') })
  await expect(ctx.mydot.projectFoundryObservation(selection)).rejects.toThrow('session "observation-not-stored" not found')
})

it('refuses child lineage and requires a recorded workspace before reading any approved file', async ({ onTestFinished }) => {
  const { ctx, space } = await setupCaps(onTestFinished)
  const root = ctx.sessions.create(SessionId('observation-no-workspace'))
  await ctx.mydot.attach(root.id, space.id)
  const first = root.append('turn/start', { turn: 1 })
  const request = root.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Root request' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const last = root.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await using writer = await ctx.sessionPersistence.create(root.header)
  await writer.append([first, request, last])
  await writer.flush()
  const selection = {
    projectId: 'bound-project', spaceId: space.id, sessionId: root.id,
    firstSequence: first.seq, lastSequence: last.seq, requestSequence: request.seq, artifacts: [],
  }
  expect((await ctx.mydot.projectFoundryObservation(selection)).observation.status).toBe('SUCCEEDED')
  await expect(ctx.mydot.projectFoundryObservation({
    ...selection, artifacts: [{
      path: 'guide.md', sourceRef: 'guide', version: '1', artifactType: 'MARKDOWN_DOCUMENT', contentDigest: '0'.repeat(64),
    }],
  })).rejects.toThrow('requires a recorded local workspace')
  const child = ctx.sessions.create(SessionId('observation-child'), { meta: { parentSession: root.id, origin: 'subagent' } })
  await using childWriter = await ctx.sessionPersistence.create(child.header)
  await childWriter.flush()
  await ctx.mydot.attach(child.id, space.id)
  await expect(ctx.mydot.projectFoundryObservation({ ...selection, sessionId: child.id })).rejects.toThrow('requires a root Session')
})

it.for([
  ['approval', 'needs_approval', 'not_applicable', ['check']],
  ['other-task', 'not_dispatched', 'not_applicable', ['check']],
  ['denied', 'rejected', 'not_applicable', ['check', 'invoke']],
  ['lost', 'unknown', 'not_applicable', ['check', 'invoke']],
  ['cancelled', 'cancelled', 'not_applicable', ['check', 'invoke']],
  ['changed', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['linked', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['directory', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['missing-file', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['missing-reference', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['partial-receipt', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['foreign-source', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['wrong-name', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['wrong-manifest', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['wrong-digest', 'unknown', 'not_applicable', ['check', 'invoke']],
  ['wrong-request', 'unknown', 'not_applicable', ['check', 'invoke']],
  ['bad-path', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['wrong-bytes', 'succeeded', 'unavailable', ['check', 'invoke']],
  ['other-receipt', 'unknown', 'not_applicable', ['check', 'invoke']],
  ['bad-wire', 'unknown', 'not_applicable', ['check', 'invoke']],
  ['inflight', 'unknown', 'not_applicable', ['check', 'invoke']],
  ['bad-null', 'unknown', 'not_applicable', ['check', 'invoke']],
  ['bad-check', 'not_dispatched', 'not_applicable', ['check']],
  ['check-lost', 'not_dispatched', 'not_applicable', ['check']],
] as const)('keeps %s distinct and publishes no artifact', async ([name, status, handoff, phases], { onTestFinished }) => {
  const { ctx, workspace, space } = await setupCaps(onTestFinished)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse(name, 'caps_compile_document_bundle', { name, documents: [{ source: 'guide.md' }] }),
    textResponse('Done'),
  ]))
  const agent = await ctx.agentLoop.create(SessionId('caps-' + name), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  await ctx.mydot.attach(agent.id, space.id)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Compile guide.md' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
  using observed = await ctx.sessionQuery.observeSession(agent.id)
  const meta = observed.events.find(event => event.type === 'tool/result')?.data.meta
  expect(meta).toMatchObject({ status, handoff })
  const projected = await ctx.mydot.projectFoundryObservation({
    projectId: 'bound-project', spaceId: space.id, sessionId: agent.id,
    firstSequence: observed.events.find(event => event.type === 'turn/start')!.seq,
    lastSequence: observed.events.find(event => event.type === 'turn/end')!.seq,
    requestSequence: observed.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')!.seq,
    artifacts: [],
  })
  const statusForFoundry = { succeeded: 'SUCCEEDED', cancelled: 'CANCELLED', rejected: 'FAILED' } as const
  expect(projected.observation.status).toBe(status in statusForFoundry ? statusForFoundry[status as keyof typeof statusForFoundry] : 'UNKNOWN')
  expect(projected.observation.events.find(event => event.type === 'TOOL_CALL_END')?.payload.status).toBe(status)
  if (name === 'inflight') expect(meta).toMatchObject({ duplicate: true, usageRecording: 'unknown' })
  expect(observed.events.some(event => event.type === 'deliverables/presented')).toBe(false)
  const rows = (await readFile(join(workspace, 'calls.jsonl'), 'utf8')).trimEnd().split('\n')
  expect(rows.map(line => (JSON.parse(line) as { phase: string }).phase)).toEqual(phases)
})

it('rejects Caps authority from arguments, agentless calls and Sessions without an open turn', async ({ onTestFinished }) => {
  const { ctx, workspace, space } = await setupCaps(onTestFinished)
  const tool = 'caps_compile_document_bundle'
  const valid = { name: 'bundle', documents: [{ source: 'guide.md' }] }
  const call = { name: tool, arguments: valid, callId: ToolCallId('outside'), signal: new AbortController().signal }
  expect(await ctx.tools.execute(call)).toMatchObject({ isError: true })
  const adapter = new MockAdapter([toolCallResponse('forged', tool, { ...valid, requestId: 'foreign' }), textResponse('Done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('caps-forge'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  await ctx.mydot.attach(agent.id, space.id)
  expect(await ctx.tools.execute({ ...call, agent })).toMatchObject({ isError: true })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Compile guide.md' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  using observed = await ctx.sessionQuery.observeSession(agent.id)
  expect(JSON.stringify(observed.events.find(event => event.type === 'tool/result'))).toContain('Caps accepts valid bundle arguments only')
  const projected = await ctx.mydot.projectFoundryObservation({
    projectId: 'bound-project', spaceId: space.id, sessionId: agent.id,
    firstSequence: observed.events.find(event => event.type === 'turn/start')!.seq,
    lastSequence: observed.events.find(event => event.type === 'turn/end')!.seq,
    requestSequence: observed.events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')!.seq,
    artifacts: [],
  })
  expect(projected.hccScope).toBeNull()
  expect(projected.observation.status).toBe('UNKNOWN')
  expect(projected.observation.events.find(event => event.type === 'TOOL_ERROR')?.payload).toEqual({ status: 'unverified' })
  await expect(readFile(join(workspace, 'calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.for([
  ['no-space', 'Caps requires an active MyDot Space'],
  ['read-only', 'Caps is unavailable for this Session workspace or policy'],
  ['outside', 'Caps documents must be regular files'],
  ['unpersisted', 'Caps requires durable Session storage'],
  ['unsafe-launcher', 'operator-managed executable'],
] as const)('refuses %s before reaching the launcher', async ([scenario, message], { onTestFinished }) => {
  const { ctx, workspace, space, launcher } = await setupCaps(onTestFinished, { persist: scenario !== 'unpersisted' })
  const source = scenario === 'outside' ? '../guide.md' : 'guide.md'
  if (scenario === 'unsafe-launcher') await chmod(launcher, 0o666)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse(scenario, 'caps_compile_document_bundle', { name: 'bundle', documents: [{ source }] }),
    textResponse('Done'),
  ]))
  const agent = await ctx.agentLoop.create(SessionId('caps-' + scenario), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  if (scenario !== 'no-space') await ctx.mydot.attach(agent.id, space.id)
  if (scenario === 'read-only') setSandboxMode(agent.session, 'read-only')
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Compile guide.md' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  using observed = await ctx.sessionQuery.observeSession(agent.id)
  expect(JSON.stringify(observed.events.find(event => event.type === 'tool/result'))).toContain(message)
  await expect(readFile(join(workspace, 'calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a configured launcher inside an enrolled workspace', async ({ onTestFinished }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mydot-caps-config-')))
  onTestFinished(async () => { await rename(root, root + '.tobedeleted') })
  await expect(setup({ root, pool: new MemoryMediaPool() }, undefined, {
    caps: { launcher: join(root, 'local'), workspaceRoots: [root], timeoutMs: 5_000 },
  })).rejects.toThrow('requires an absolute external launcher')
})
