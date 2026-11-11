/** Host admission, recorded context, authorization and lifecycle regression coverage. */
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, request as httpRequest } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
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
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Goals from '@deepseek-ai/dsh-goal'
import type { RemoteInvocation, PeerId } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { Config, SpaceId } from '../src/index.ts'
import '../src/index.ts'
import { humanAnswerSchema, surveyResultSchema } from '../src/human-handoff-state.ts'
import type { HumanRequestId, SurveyHandoffResult } from '../src/types.ts'
import { HumanHandoffService } from '../src/human-handoff.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { mydotTestGuest: { readonly kind: 'mydot-test-guest' } }
}

const contexts: Context[] = []
const servers: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(close => close()))
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
async function reportsToolError(operation: ReturnType<Context['tools']['execute']>, expected: string): Promise<void> {
  const result = await operation
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain(expected)
}
const spaceInput = { name: 'Research', purpose: 'Compare the report', instructions: 'Cite sources', materials: [] }

it('requires an explicit bounded callback deadline and a fixed credential-free loopback origin', () => {
  const base = { humanHandoffEnabled: true, humanHandoffSocketPath: '/private/callback.sock', humanHandoffSurveyOrigin: 'http://127.0.0.1:3211', maxTextBytes: 4096, humanHandoffTimeoutMs: 1000 }
  const invalid = [
    { humanHandoffTimeoutMs: undefined }, { humanHandoffTimeoutMs: 0 }, { humanHandoffTimeoutMs: 1.5 },
    { humanHandoffTimeoutMs: Number.MAX_SAFE_INTEGER },
    { humanHandoffSurveyOrigin: 'http://example.test/' }, { humanHandoffSurveyOrigin: 'https://127.0.0.1/' },
    { humanHandoffSurveyOrigin: 'http://user@127.0.0.1/' }, { humanHandoffSurveyOrigin: 'http://user:secret@127.0.0.1/' },
    { humanHandoffSurveyOrigin: 'http://127.0.0.1/path' }, { humanHandoffSurveyOrigin: 'http://127.0.0.1/?query' }, { humanHandoffSurveyOrigin: 'http://127.0.0.1/#fragment' },
    { humanHandoffEnabled: false },
  ]
  for (const overrides of invalid) {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => new HumanHandoffService(ctx, { ...base, ...overrides } as Config)).toThrow(/requires|Enable/)
  }
})
const surveyTarget = { caseId: 'public-case', sourceId: 'public-source', sourceRevision: 'a'.repeat(64), baseRevisionId: 'b'.repeat(64), baseVersion: 1, workflow: 'assisted-correction' as const }
const surveyInput = (requestId: string) => ({ requestId, question: 'Review the public drawing', reason: 'The original source needs a human reference',
  evidenceUrl: 'https://example.test/survey', resumeInstruction: 'Re-evaluate the saved result', options: [], target: surveyTarget })
const surveyResult = (requestId: string): SurveyHandoffResult => surveyResultSchema.parse({ schemaVersion: 1, requestId, status: 'saved',
  source: { caseId: surveyTarget.caseId, sourceId: surveyTarget.sourceId, sourceRevision: surveyTarget.sourceRevision, manifestId: 'c'.repeat(64) },
  baseSurvey: { revisionId: surveyTarget.baseRevisionId, version: surveyTarget.baseVersion }, survey: { revisionId: 'd'.repeat(64), version: 2 },
  planning: { caseId: surveyTarget.caseId, revisionId: 'planning-public-2', headVersion: 0 }, goldId: null })
async function surveyBench() {
  const socketDirectory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-handoff-callback-')))
  let status = 200
  let result = surveyResult('callback-review')
  let current = { survey: true, planning: true }
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url!)
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ result, current }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  servers.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The test needs the bound HTTP address')
  const config = { humanHandoffEnabled: true, humanHandoffSocketPath: join(socketDirectory, 'callback.sock'),
    humanHandoffSurveyOrigin: `http://127.0.0.1:${address.port}`, humanHandoffTimeoutMs: 1000 }
  const runtime = await setup(config)
  async function callback(value = result, requestRevision = 1) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({ socketPath: config.humanHandoffSocketPath, path: `/human-requests/${value.requestId}/answers`, method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Uint8Array) => { chunks.push(Buffer.from(chunk)) })
        response.on('end', () => { resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }) })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end(JSON.stringify({ requestRevision, result: value }))
    })
  }
  return { ...runtime, config, paths, callback,
    set: (value: SurveyHandoffResult, heads = { survey: true, planning: true }, code = 200) => {
      result = value; current = heads; status = code
    } }
}

it('binds a private source link and accepts explicit survey deferral or unknown without a saved result', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const origin = await ctx.agentLoop.create(SessionId('survey-disposition'))
  for (const choice of ['deferred', 'unknown', 'needs-material', 'rejected']) {
    const prepared = await ctx.mydotHandoff.prepare(origin, surveyInput(`survey-${choice}`))
    const link = new URL(prepared.request.evidenceUrl)
    expect(Object.fromEntries(link.searchParams)).toMatchObject({ requestId: `survey-${choice}`, requestRevision: '1', caseId: 'public-case', case: 'public-case',
      source: 'public-source', sourceRevision: surveyTarget.sourceRevision, baseRevisionId: surveyTarget.baseRevisionId, baseVersion: '1', workflow: 'assisted-correction' })
    const receipt = await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: prepared.request.requestId, requestRevision: 1,
      submissionId: `public-${choice}`, choice, text: 'Additional source required', result: null }))
    expect(receipt).toMatchObject({ phase: 'stopped', answer: { choice, result: null } })
    expect(await ctx.mydotHandoff.reconcile(prepared.request.requestId)).toMatchObject({ phase: 'stopped' })
  }
  expect([...origin.inbox.nextTurn, ...origin.inbox.nextStep]).toHaveLength(0)
})

it('admits one exact server-saved answer through the protected callback and does not replay duplicate saves', async () => {
  const b = await surveyBench()
  b.ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('saved public drawing consumed')]))
  const origin = await b.ctx.agentLoop.create(SessionId('survey-callback'), { provider: 'mock', model: 'mock' }, { cwd: b.root })
  await b.ctx.mydotHandoff.prepare(origin, surveyInput('callback-review'))
  expect((await b.callback()).status).toBe(200)
  await origin.whenIdle()
  expect((await b.ctx.mydotHandoff.snapshot())[0]).toMatchObject({ phase: 'resumed', request: { sessionId: origin.id }, answer: { result: surveyResult('callback-review') } })
  expect((await b.callback()).status).toBe(200)
  expect(b.paths.every(path => path === '/api/survey/public-case/public-source/handoffs/callback-review')).toBe(true)
  expect(origin.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === 'handoff:callback-review:1')).toHaveLength(1)
})

it('keeps changed heads and mismatched source/base/planning results pending without model admission', async () => {
  const b = await surveyBench()
  const origin = await b.ctx.agentLoop.create(SessionId('survey-stale'))
  await b.ctx.mydotHandoff.prepare(origin, surveyInput('callback-review'))
  const result = surveyResult('callback-review')
  for (const heads of [{ survey: false, planning: true }, { survey: true, planning: false }]) {
    b.set(result, heads)
    expect((await b.callback()).status).toBe(409)
  }
  const cases: SurveyHandoffResult[] = [
    { ...result, source: { ...result.source, sourceRevision: 'e'.repeat(64) } },
    { ...result, baseSurvey: { ...result.baseSurvey, revisionId: 'e'.repeat(64) } },
    { ...result, baseSurvey: { ...result.baseSurvey, version: 2 } },
    { ...result, source: { ...result.source, caseId: 'other-case' } },
    { ...result, source: { ...result.source, sourceId: 'other-source' } },
    { ...result, planning: { caseId: 'other-case', revisionId: 'other-planning', headVersion: 0 } },
  ]
  for (const changed of cases) {
    b.set(changed)
    expect((await b.callback(changed)).status).toBe(409)
  }
  b.set(result)
  expect((await b.callback({ ...result, survey: { revisionId: 'f'.repeat(64), version: 3 } })).body).toContain('authoritative survey result changed')
  expect((await b.ctx.mydotHandoff.snapshot())[0]?.phase).toBe('pending')
  expect([...origin.inbox.nextTurn, ...origin.inbox.nextStep]).toHaveLength(0)
})

it('recovers the persisted external save on Host reload when its callback never arrived', async () => {
  const b = await surveyBench()
  b.ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('recovered saved drawing consumed')]))
  const origin = await b.ctx.agentLoop.create(SessionId('survey-recovery'), { provider: 'mock', model: 'mock' }, { cwd: b.root })
  await b.ctx.mydotHandoff.prepare(origin, surveyInput('callback-review'))
  await b.entry.update({ disabled: true })
  await b.entry.update({ disabled: false })
  await b.entry.fiber!.await()
  await origin.whenIdle()
  expect((await b.ctx.mydotHandoff.snapshot())[0]?.phase).toBe('resumed')
  await b.entry.update({ disabled: true }); await b.entry.update({ disabled: false }); await b.entry.fiber!.await()
  expect(origin.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === 'handoff:callback-review:1')).toHaveLength(1)
})

it('keeps temporarily unavailable survey recovery pending and recovers by the targeted owner operation', async () => {
  const b = await surveyBench()
  b.ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('recovered by owner')]))
  const origin = await b.ctx.agentLoop.create(SessionId('survey-unavailable'), { provider: 'mock', model: 'mock' }, { cwd: b.root })
  const prepared = await b.ctx.mydotHandoff.prepare(origin, surveyInput('callback-review'))
  b.set(surveyResult('callback-review'), undefined, 503)
  await b.entry.update({ disabled: true }); await b.entry.update({ disabled: false }); await b.entry.fiber!.await()
  expect((await b.ctx.mydotHandoff.snapshot())[0]?.phase).toBe('pending')
  await expect(b.ctx.mydotHandoff.reconcile(prepared.request.requestId)).rejects.toThrow('available')
  b.set(surveyResult('callback-review'))
  await b.ctx.mydotHandoff.reconcile(prepared.request.requestId)
  await origin.whenIdle()
  expect((await b.ctx.mydotHandoff.snapshot())[0]?.phase).toBe('resumed')
})

it('verifies an owner-submitted result and preserves saved external deferral as a stopped request', async () => {
  const b = await surveyBench()
  b.ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('explicit saved answer consumed')]))
  const origin = await b.ctx.agentLoop.create(SessionId('explicit-survey'), { provider: 'mock', model: 'mock' }, { cwd: b.root })
  const prepared = await b.ctx.mydotHandoff.prepare(origin, surveyInput('callback-review'))
  await b.ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: prepared.request.requestId, requestRevision: 1, submissionId: 'explicit-save', choice: 'confirmed', text: '', result: surveyResult('callback-review') }))
  await origin.whenIdle()
  expect((await b.ctx.mydotHandoff.snapshot())[0]?.phase).toBe('resumed')
  for (const status of ['deferred', 'needs-material'] as const) {
    const id = `saved-${status}`
    const result = { ...surveyResult(id), status, planning: null }
    b.set(result)
    await b.ctx.mydotHandoff.prepare(origin, surveyInput(id))
    expect((await b.callback(result)).status).toBe(200)
    expect((await b.ctx.mydotHandoff.snapshot()).find(view => view.request.requestId === id)).toMatchObject({ phase: 'stopped', answer: { choice: status } })
    await b.ctx.mydotHandoff.cancel(result.requestId)
    expect((await b.callback(result)).status).toBe(409)
  }
})

it('stops a saved answer if verification becomes unavailable between receipt and delivery', async () => {
  const b = await surveyBench()
  const origin = await b.ctx.agentLoop.create(SessionId('survey-verification-gap'))
  const prepared = await b.ctx.mydotHandoff.prepare(origin, surveyInput('callback-review'))
  const actualFetch = globalThis.fetch
  const fetcher = vi.spyOn(globalThis, 'fetch')
  fetcher.mockImplementationOnce(actualFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
  const receipt = await b.ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: prepared.request.requestId, requestRevision: 1, submissionId: 'verification-gap', choice: 'confirmed', text: '', result: surveyResult('callback-review') }))
  expect(receipt).toMatchObject({ phase: 'stopped', answer: { submissionId: 'verification-gap' } })
  expect(receipt.reason).toContain('cannot be verified')
  expect(receipt.rpcId).toBeUndefined()
  expect([...origin.inbox.nextTurn, ...origin.inbox.nextStep]).toHaveLength(0)
})

it('requires configured authoritative verification and exact request identity for a survey answer', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const origin = await ctx.agentLoop.create(SessionId('survey-unconfigured'))
  const view = await ctx.mydotHandoff.prepare(origin, surveyInput('unconfigured-survey'))
  await expect(ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'unverified', choice: 'confirmed', text: '', result: surveyResult('unconfigured-survey') }))).rejects.toThrow('not configured')
  const b = await surveyBench()
  const bound = await b.ctx.agentLoop.create(SessionId('survey-request-binding'))
  await b.ctx.mydotHandoff.prepare(bound, surveyInput('callback-review'))
  const another = surveyResult('another-request')
  b.set(another)
  await expect(b.ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: 'callback-review', requestRevision: 1, submissionId: 'wrong-request-result', choice: 'confirmed', text: '', result: another }))).rejects.toThrow('original source')
})

it('ignores foreign ledger placement and refuses a persisted global request identity collision', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const origin = await ctx.agentLoop.create(SessionId('ledger-owner'))
  const request = (await ctx.mydotHandoff.prepare(origin, { requestId: 'ledger-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })).request
  const foreign = ctx.sessions.create(SessionId('ledger-foreign'))
  foreign.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'cold-ledger-input' }, content: [] }), { surfaceOp: 'append' })
  foreign.append('mydot/human-handoff', { kind: 'prepared', request: { ...request, requestId: 'foreign-parent' as HumanRequestId, parentSessionId: origin.id } })
  foreign.append('mydot/human-handoff', { kind: 'prepared', request: { ...request, requestId: 'foreign-root' as HumanRequestId } })
  expect(await ctx.mydotHandoff.snapshot()).toHaveLength(1)
  foreign.append('mydot/human-handoff', { kind: 'prepared', request: { ...request, sessionId: foreign.id } })
  await expect(ctx.mydotHandoff.snapshot()).rejects.toThrow('multiple Sessions')
})

it('does not infer a request from a source whose projection is unavailable', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const origin = await ctx.agentLoop.create(SessionId('projection-unavailable'))
  const prepared = await ctx.mydotHandoff.prepare(origin, { requestId: 'projection-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  const spy = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(id => observe(id, { projectionMode: 'none' }))
  expect(await ctx.mydotHandoff.snapshot()).toEqual([])
  spy.mockRestore()
  expect((await ctx.mydotHandoff.snapshot())[0]?.request.requestId).toBe(prepared.request.requestId)
})

it('reconciles a durable received receipt and concurrent identical answers without duplicate admission', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('reconciled receipt consumed'), textResponse('concurrent answer consumed')]))
  const origin = await ctx.agentLoop.create(SessionId('received-reconcile'), { provider: 'mock', model: 'mock' }, { cwd: root })
  await expect(ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: 'absent', requestRevision: 1, submissionId: 'absent', choice: 'unknown', text: '', result: null }))).rejects.toThrow('not found')
  for (const mode of ['received', 'concurrent'] as const) {
    const view = await ctx.mydotHandoff.prepare(origin, { requestId: `receipt-${mode}`, question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
    const answer = humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: mode, choice: 'confirmed', text: '', result: null })
    if (mode === 'received') {
      origin.session.append('mydot/human-handoff', { kind: 'received', requestId: view.request.requestId, answer, responder: 'host-owner' })
      await ctx.sessions.flush(origin.session)
      await ctx.mydotHandoff.reconcile(view.request.requestId)
    } else await Promise.all([ctx.mydotHandoff.answer(answer), ctx.mydotHandoff.answer(answer)])
    await origin.whenIdle()
    expect(origin.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === `handoff:receipt-${mode}:1`)).toHaveLength(1)
  }
})

it('keeps guest and automatic handoff inputs parked while a fresh explicit owner RPC can supersede the request', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const origin = await ctx.agentLoop.create(SessionId('owner-input-gate'))
  const view = await ctx.mydotHandoff.prepare(origin, { requestId: 'owner-input-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  const guests = [createUserMessage({ source: { kind: 'user', rpcId: 'guest-rpc' as SessionRequestId, principal: { kind: 'mydot-test-guest' } }, content: [] }),
    createUserMessage({ source: { kind: 'user', rpcId: 'handoff:other:1' }, content: [] })]
  for (const input of guests) expect(await agentEvents(ctx, origin).waterfall('agent/pre-step', { messages: [input], turn: 1, step: 1, signal: signal() }, async () => ({ kind: 'enter', messages: [input] }))).toMatchObject({ kind: 'reject' })
  const owner = createUserMessage({ source: { kind: 'user', rpcId: 'new-owner-rpc' }, content: [] })
  expect(await agentEvents(ctx, origin).waterfall('agent/pre-step', { messages: [owner], turn: 1, step: 1, signal: signal() }, async () => ({ kind: 'enter', messages: [owner] }))).toMatchObject({ kind: 'enter' })
  expect(await ctx.mydotHandoff.cancel(view.request.requestId)).toMatchObject({ phase: 'retired' })
})

it('recovers a durably received answer on the original cold root before acknowledging a retry', async () => {
  const { ctx, root, entry } = await setup({ humanHandoffEnabled: true })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('recovered original root consumed answer')]))
  const original = await ctx.agents.create({ sessionId: SessionId('cold-root-receipt'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
  const view = await ctx.mydotHandoff.prepare(original.agent, { requestId: 'root-receipt', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  const answer = humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'received-before-crash', choice: 'confirmed', text: '', result: null })
  original.agent.session.append('mydot/human-handoff', { kind: 'received', requestId: view.request.requestId, answer, responder: 'host-owner' })
  await ctx.sessions.flush(original.agent.session)
  await original.dispose()
  const resolveAgent = vi.fn<typeof ctx.sessionController.resolveAgent>(async id => ({
    agent: (await ctx.agents.resume({ resumeSessionId: id,
      agentOptions: { provider: 'mock', model: 'mock' } })).agent }))
  ctx.sessionController.resolveAgent = resolveAgent
  await entry.update({ disabled: true }); await entry.update({ disabled: false }); await entry.fiber!.await()
  await ctx.mydotHandoff.snapshot()
  const resumed = ctx.agents.get(original.agent.id)!
  await resumed.whenIdle()
  expect(await ctx.mydotHandoff.answer(answer)).toMatchObject({ phase: 'resumed' })
  expect(resolveAgent).toHaveBeenCalledWith(original.agent.id)
  expect(resumed.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === 'handoff:root-receipt:1')).toHaveLength(1)
})

it('uses persisted original-child input to distinguish consumed, live-queued and unknown delivery after reload', async () => {
  const { ctx, root, entry } = await setup({ humanHandoffEnabled: true })
  const parent = await ctx.agents.create({ sessionId: SessionId('admission-parent'), meta: { cwd: root } })
  for (const mode of ['consumed', 'unknown', 'live'] as const) {
    const child = await ctx.agents.create({ sessionId: SessionId(`admission-${mode}`), parentAgent: parent.agent, meta: { cwd: root } })
    const view = await ctx.mydotHandoff.prepare(child.agent, { requestId: `delivery-${mode}`, question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
    if (mode === 'consumed') {
      child.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [] }), { surfaceOp: 'append' })
      child.agent.session.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'other-input' }, content: [] }), { surfaceOp: 'append' })
      child.agent.session.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: `handoff:delivery-${mode}:1` }, content: [] }), { surfaceOp: 'append' })
    }
    parent.agent.session.append('mydot/human-handoff', { kind: 'dispatching', requestId: view.request.requestId, rpcId: `handoff:delivery-${mode}:1` })
    parent.agent.session.append('mydot/human-handoff', { kind: 'queued', requestId: view.request.requestId })
    await ctx.sessions.flush(parent.agent.session); await ctx.sessions.flush(child.agent.session)
    if (mode !== 'live') await child.dispose()
  }
  await entry.update({ disabled: true }); await entry.update({ disabled: false }); await entry.fiber!.await()
  const views = await ctx.mydotHandoff.snapshot()
  expect(views.find(view => view.request.requestId === 'delivery-consumed')).toMatchObject({ phase: 'resumed' })
  expect(views.find(view => view.request.requestId === 'delivery-unknown')).toMatchObject({ phase: 'stopped' })
  expect(views.find(view => view.request.requestId === 'delivery-unknown')?.reason).toContain('not been replayed')
  expect(views.find(view => view.request.requestId === 'delivery-live')).toMatchObject({ phase: 'queued' })
  expect(await ctx.mydotHandoff.reconcile('delivery-live' as HumanRequestId)).toMatchObject({ phase: 'queued' })
  expect(ctx.agents.get(SessionId('admission-unknown'))).toBeUndefined()
  for (const id of [parent.agent.id, SessionId('admission-live')]) expect([...ctx.agents.get(id)!.inbox.nextTurn, ...ctx.agents.get(id)!.inbox.nextStep]).toHaveLength(0)
})

it('stops ambiguous dispatch without replay and requires new owner work to supersede it', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const original = await ctx.agentLoop.create(SessionId('delivery-failed'))
  const view = await ctx.mydotHandoff.prepare(original, { requestId: 'unknown-dispatch', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  const followup = vi.spyOn(original, 'followup').mockImplementationOnce(() => { throw new Error('queue outcome unavailable') })
  const answer = humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'ambiguous-answer', choice: 'confirmed', text: '', result: null })
  const receipt = await ctx.mydotHandoff.answer(answer)
  expect(receipt).toMatchObject({ phase: 'stopped', rpcId: 'handoff:unknown-dispatch:1' })
  expect(await ctx.mydotHandoff.reconcile(view.request.requestId)).toMatchObject({ phase: 'stopped' })
  expect(await ctx.mydotHandoff.answer(answer)).toMatchObject({ phase: 'stopped' })
  expect(followup).toHaveBeenCalledOnce()
})

it('recovers an answer whose first flush failed without sending it until recovery is explicit', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('recovered after durability')]))
  const original = await ctx.agentLoop.create(SessionId('recover-durability'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const view = await ctx.mydotHandoff.prepare(original, { requestId: 'recover-flush', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('temporary disk error'))
  await expect(ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'disk-retry', choice: 'confirmed', text: '', result: null }))).rejects.toThrow('temporary disk')
  expect([...original.inbox.nextTurn, ...original.inbox.nextStep]).toHaveLength(0)
  await ctx.mydotHandoff.reconcile(view.request.requestId)
  await original.whenIdle()
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('resumed')
})

it('refuses absent original writers and mismatched generic/survey response types', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  await expect(ctx.mydotHandoff.cancel('not-found' as HumanRequestId)).rejects.toThrow('not found')
  const origin = await ctx.agents.create({ sessionId: SessionId('missing-writer') })
  const view = await ctx.mydotHandoff.prepare(origin.agent, { requestId: 'writer-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  const answer = humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'writer-answer', choice: 'confirmed', text: '', result: surveyResult('writer-review') })
  await expect(ctx.mydotHandoff.answer(answer)).rejects.toThrow('no survey target')
  await ctx.mydotHandoff.cancel(view.request.requestId)
  await expect(ctx.mydotHandoff.answer({ ...answer, result: null })).rejects.toThrow('no longer pending')
  await origin.dispose()
  const other = await ctx.agentLoop.create(SessionId('new-live-owner'))
  await ctx.mydotHandoff.prepare(other, { requestId: 'other-owner-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  ctx.sessionController.resolveAgent = vi.fn(async () => ({ error: new RemoteError('session/not-found', 'Original writer is unavailable', { sessionId: origin.agent.id }) }))
  await expect(ctx.mydotHandoff.reconcile(view.request.requestId)).rejects.toThrow('Original writer')
})

it('guards live goal changes and consumed rounds without resetting or silently rearming them', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  await ctx.plugin(Goals)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('bounded goal answer consumed')]))
  for (const mode of ['unchanged', 'new', 'cleared', 'edited', 'paused', 'exhausted', 'replaced'] as const) {
    const original = await ctx.agentLoop.create(SessionId(`goal-${mode}`), { provider: 'mock', model: 'mock' }, { cwd: root })
    const goal = mode === 'new' ? undefined : ctx.goals.create(original, { objective: 'Finish within existing bounds', maxGoalRounds: 1 })
    const view = await ctx.mydotHandoff.prepare(original, { requestId: `goal-review-${mode}`, question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
    if (mode === 'new') ctx.goals.create(original, { objective: 'New unrelated goal', maxGoalRounds: 1 })
    if (goal !== undefined) {
      if (mode === 'cleared') ctx.goals.clear(original, goal)
      if (mode === 'edited') ctx.goals.edit(original, goal, { objective: 'Different work' })
      if (mode === 'paused') ctx.goals.pause(original, goal)
      if (mode === 'replaced') { ctx.goals.complete(original, goal); ctx.goals.create(original, { objective: 'Replacement', maxGoalRounds: 1 }) }
      if (mode === 'exhausted') {
        original.session.append('turn/start', { turn: 1 })
        original.session.append('user/message', createUserMessage({ source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 }, content: [] }), { surfaceOp: 'append' })
        original.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      }
    }
    const receipt = await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: `answer-${mode}`, choice: 'confirmed', text: '', result: null }))
    await original.whenIdle()
    if (mode === 'unchanged') {
      expect(['queued', 'claimed', 'resumed']).toContain(receipt.phase)
      expect(ctx.goals.get(original)).toMatchObject({ id: goal!.id, revision: 1, activation: 'disarmed', roundsStarted: 0 })
    } else expect(receipt.phase).toBe('stopped')
    if (mode === 'exhausted') expect(ctx.goals.get(original)?.roundsStarted).toBe(1)
  }
})

it('rechecks goal authority immediately before admission and blocks automatic waiting input', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  await ctx.plugin(Goals)
  const original = await ctx.agentLoop.create(SessionId('goal-admission-race'), {}, { cwd: root })
  const goal = ctx.goals.create(original, { objective: 'Work after owner answer', maxGoalRounds: 2 })
  const view = await ctx.mydotHandoff.prepare(original, { requestId: 'goal-race', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  const automatic = createUserMessage({ source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 }, content: [] })
  expect(await agentEvents(ctx, original).waterfall('agent/pre-step', { messages: [automatic], turn: 1, step: 1, signal: signal() }, async () => ({ kind: 'enter', messages: [automatic] }))).toMatchObject({ kind: 'reject' })
  ctx.on('agent/pre-step', async (_args, next) => { const result = await next(); ctx.goals.pause(original, goal); return result })
  await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'race-answer', choice: 'confirmed', text: '', result: null }))
  await original.whenIdle()
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('stopped')
  expect((await ctx.mydotHandoff.snapshot())[0]?.reason).toContain('Goal no longer')
  expect(original.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(0)
})

it('flushes a human answer before resuming the exact original Session and deduplicates retries', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  const adapter = new MockAdapter([textResponse('human answer consumed')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('human-origin'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const prepared = await ctx.mydotHandoff.prepare(agent, { requestId: 'decision-1', question: 'Which result?', reason: 'Only the owner knows the intended scope',
    evidenceUrl: '', resumeInstruction: 'Continue with the selected scope', options: ['confirmed'], target: null })
  expect(prepared.phase).toBe('pending')
  const input = humanAnswerSchema.parse({ requestId: prepared.request.requestId, requestRevision: 1, submissionId: 'answer-1', choice: 'confirmed', text: 'Use the current report', result: null })
  const receipt = await ctx.mydotHandoff.answer(input)
  expect(['dispatching', 'queued', 'claimed', 'resumed']).toContain(receipt.phase)
  await agent.whenIdle()
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('resumed')
  expect(await ctx.mydotHandoff.answer(input)).toMatchObject({ phase: 'resumed' })
  await expect(ctx.mydotHandoff.answer({ ...input, text: 'changed' })).rejects.toThrow('different')
  using source = await ctx.sessionQuery.observeSession(agent.id)
  const admitted = source.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === 'handoff:decision-1:1')
  expect(admitted).toHaveLength(1)
})

it('does not acknowledge or run an answer when persistence fails', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  const agent = await ctx.agentLoop.create(SessionId('human-durability'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const prepared = await ctx.mydotHandoff.prepare(agent, { requestId: 'decision-2', question: 'Confirm?', reason: 'An owner decision is required',
    evidenceUrl: '', resumeInstruction: 'Continue after confirmation', options: ['confirmed'], target: null })
  vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: prepared.request.requestId, requestRevision: 1, submissionId: 'answer-2', choice: 'confirmed', text: '', result: null }))).rejects.toThrow('disk unavailable')
  expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toHaveLength(0)
})

it('retries a failed preparation durability barrier before returning its pending receipt', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const agent = await ctx.agentLoop.create(SessionId('human-prepare-flush'))
  const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValueOnce(false)
  const input = { requestId: 'prepare-flush', question: 'Choose?', reason: 'Owner choice', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null }
  await expect(ctx.mydotHandoff.prepare(agent, input)).rejects.toThrow('durable')
  expect(await ctx.mydotHandoff.prepare(agent, input)).toMatchObject({ phase: 'pending' })
  expect(flush).toHaveBeenCalledTimes(2)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'mydot/human-handoff')).toHaveLength(1)
})

it('rejects unsupported origins, incompatible review choices and oversized requests before preparing', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true, maxTextBytes: 2000 })
  const root = await ctx.agents.create({ sessionId: SessionId('prepare-root') })
  const child = await ctx.agents.create({ sessionId: SessionId('prepare-child'), parentAgent: root.agent })
  const grandchild = await ctx.agents.create({ sessionId: SessionId('prepare-grandchild'), parentAgent: child.agent })
  const capped = await ctx.agents.create({ sessionId: SessionId('prepare-capped'), parentAgent: root.agent, agentOptions: { maxTokens: 100 } })
  const input = surveyInput('prepare-invalid')
  await expect(ctx.mydotHandoff.prepare(grandchild.agent, input)).rejects.toThrow('Nested')
  await expect(ctx.mydotHandoff.prepare(capped.agent, input)).rejects.toThrow('token cap')
  await expect(ctx.mydotHandoff.prepare(root.agent, { ...input, evidenceUrl: '' })).rejects.toThrow('source link')
  await expect(ctx.mydotHandoff.prepare(root.agent, { ...input, evidenceUrl: 'https://example.test/?case=wrong-case' })).rejects.toThrow('same survey')
  await expect(ctx.mydotHandoff.prepare(root.agent, { ...input, target: { ...surveyTarget, workflow: 'independent-reference' }, options: ['model guess'] })).rejects.toThrow('model options')
  await expect(ctx.mydotHandoff.prepare(root.agent, { ...input, question: 'x'.repeat(2001) })).rejects.toThrow('byte allowance')
  const view = await ctx.mydotHandoff.prepare(root.agent, { ...input, evidenceUrl: 'https://example.test/?case=public-case' })
  await expect(ctx.mydotHandoff.prepare(root.agent, { ...input, requestId: 'other-pending' })).rejects.toThrow('existing request')
  await expect(ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1,
    submissionId: 'no-saved-result', choice: 'confirmed', text: '', result: null }))).rejects.toThrow('Save a result')
})

it('keeps non-owner calls from listing or answering, recovering and cancelling private requests', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const origin = await ctx.agentLoop.create(SessionId('private-human-origin'))
  const prepared = await ctx.mydotHandoff.prepare(origin, { requestId: 'private-human', question: 'Private decision?', reason: 'Owner only', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  const invocation: RemoteInvocation = { request: { namespace: 'mydotHandoff', method: 'answer', args: {} }, service: 'mydotHandoff', signal: signal(),
    peer: { id: 'guest-human' as PeerId, ctx, principal: { kind: 'mydot-test-guest' }, interactions: 'answer', signal: signal(), dispose: async () => {} }, uplink: async function* () {} }
  const guest = ctx.extend({ invocation })
  const answer = humanAnswerSchema.parse({ requestId: prepared.request.requestId, requestRevision: 1, submissionId: 'guest', choice: 'unknown', text: '', result: null })
  await expect(guest.mydotHandoff.answer(answer)).rejects.toThrow('Host owner')
  await expect(guest.mydotHandoff.reconcile(prepared.request.requestId)).rejects.toThrow('Host owner')
  await expect(guest.mydotHandoff.cancel(prepared.request.requestId)).rejects.toThrow('Host owner')
  expect((await guest.mydot.snapshot()).humanRequests).toEqual([])
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('pending')
})

it('records the outcome only after the exact original Session consumes the answer and an artifact exists', async () => {
  const { ctx, root, entry } = await setup({ humanHandoffEnabled: true })
  await writeFile(join(root, 'result.md'), 'Public result evidence')
  const adapter = new MockAdapter([toolCallResponse('record-result', 'record_human_request_outcome', { request_id: 'outcome-review', outcome: 'succeeded', evidence: 'result.md' }), textResponse('result recorded')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const origin = await ctx.agentLoop.create(SessionId('human-outcome'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const view = await ctx.mydotHandoff.prepare(origin, { requestId: 'outcome-review', question: 'Use this result?', reason: 'Owner choice', evidenceUrl: '', resumeInstruction: 'Save result', options: [], target: null })
  const args = { request_id: view.request.requestId, outcome: 'succeeded', evidence: 'result.md' }
  await reportsToolError(ctx.tools.execute({ name: 'record_human_request_outcome', arguments: args, callId: ToolCallId('too-early'), signal: signal(), agent: origin }), 'consumed')
  await reportsToolError(ctx.tools.execute({ name: 'record_human_request_outcome', arguments: args, callId: ToolCallId('no-origin'), signal: signal() }), 'original Session')
  await reportsToolError(ctx.tools.execute({ name: 'prepare_human_request', arguments: humanToolInput('no-origin'), callId: ToolCallId('no-prepare-origin'), signal: signal() }), 'initiating Session')
  await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'outcome-answer', choice: 'confirmed', text: '', result: null }))
  await origin.whenIdle()
  expect((await ctx.mydotHandoff.snapshot())[0]).toMatchObject({ phase: 'outcome', outcome: 'succeeded', evidence: 'result.md' })
  expect(await ctx.mydotHandoff.cancel(view.request.requestId)).toMatchObject({ phase: 'outcome' })
  origin.session.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'handoff:outcome-review:1' }, content: [] }), { surfaceOp: 'append' })
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('outcome')
  await entry.update({ disabled: true }); await entry.update({ disabled: false }); await entry.fiber!.await()
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('outcome')
})

it('requires concrete evidence for successful work and keeps failed or unknown results explicit', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('answer consumed'), textResponse('second answer consumed')]))
  const origin = await ctx.agentLoop.create(SessionId('human-failed-outcome'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const other = await ctx.agentLoop.create(SessionId('wrong-outcome-origin'))
  for (const outcome of ['failed', 'unknown'] as const) {
    const view = await ctx.mydotHandoff.prepare(origin, { requestId: `result-${outcome}`, question: 'Continue?', reason: 'Owner choice', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
    await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: outcome, choice: 'confirmed', text: '', result: null }))
    await origin.whenIdle()
    const execute = (evidence: string, result: string = outcome, agent = origin) => ctx.tools.execute({ name: 'record_human_request_outcome',
      arguments: { request_id: view.request.requestId, outcome: result, evidence }, callId: ToolCallId(`record-${result}-${evidence}`), signal: signal(), agent })
    await reportsToolError(execute('Not this Session', outcome, other), 'exact original')
    await reportsToolError(execute(' '), 'evidence')
    await reportsToolError(execute('missing.md', 'succeeded'), 'existing result')
    await execute('The verification failed; no external operation was replayed')
    expect((await ctx.mydotHandoff.snapshot()).find(item => item.request.requestId === view.request.requestId)).toMatchObject({ phase: 'outcome', outcome })
  }
})

it('reserves a human request identity across two concurrent original Sessions', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const first = await ctx.agentLoop.create(SessionId('human-first'))
  const second = await ctx.agentLoop.create(SessionId('human-second'))
  const input = { requestId: 'same-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue this branch', options: [], target: null }
  const results = await Promise.allSettled([ctx.mydotHandoff.prepare(first, input), ctx.mydotHandoff.prepare(second, input)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  const views = await ctx.mydotHandoff.snapshot()
  expect(views).toHaveLength(1)
  expect(views[0]?.request.sessionId).toBe(first.id)
})

it('retires a deferred request on new owner input and does not replay the old answer', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('new owner work')]))
  const agent = await ctx.agentLoop.create(SessionId('human-deferred'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const view = await ctx.mydotHandoff.prepare(agent, { requestId: 'defer-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  const answer = humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'defer-one', choice: 'deferred', text: 'Later', result: null })
  expect(await ctx.mydotHandoff.answer(answer)).toMatchObject({ phase: 'stopped' })
  expect(await ctx.mydotHandoff.reconcile(view.request.requestId)).toMatchObject({ phase: 'stopped' })
  agent.followup(message('Do this different authorized task now'))
  await agent.whenIdle()
  expect((await ctx.mydotHandoff.snapshot())[0]).toMatchObject({ phase: 'retired', answer })
  expect(await ctx.mydotHandoff.answer(answer)).toMatchObject({ phase: 'retired' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.startsWith('Human response')))).toHaveLength(0)
})

it('keeps the decoder and existing request history when the feature is disabled', async () => {
  const { ctx, entry } = await setup({ humanHandoffEnabled: true })
  const agent = await ctx.agentLoop.create(SessionId('human-disabled'))
  const input = { requestId: 'disabled-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null }
  await ctx.mydotHandoff.prepare(agent, input)
  const before = agent.session.snapshotEvents()
  await entry.update({ config: { memoryDirectory: '/unused-memory', humanHandoffEnabled: false } })
  await entry.fiber!.await()
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect(ctx.sessionProjections.stateOf(agent.session, 'mydotHumanRequests')).toHaveLength(1)
  expect(await ctx.mydotHandoff.snapshot()).toEqual([])
  await expect(ctx.mydotHandoff.prepare(agent, input)).rejects.toThrow('disabled')
})

it('rejects stale revisions, unprepared answers and changed preparation without resuming', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const agent = await ctx.agentLoop.create(SessionId('human-validation'))
  const input = { requestId: 'validated-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: ['left'], target: null }
  const view = await ctx.mydotHandoff.prepare(agent, input)
  expect(await ctx.mydotHandoff.prepare(agent, input)).toEqual(view)
  await expect(ctx.mydotHandoff.prepare(agent, { ...input, reason: 'Changed' })).rejects.toThrow('different')
  const answer = humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 2, submissionId: 'invalid-one', choice: 'left', text: '', result: null })
  await expect(ctx.mydotHandoff.answer(answer)).rejects.toThrow('revision changed')
  await expect(ctx.mydotHandoff.answer({ ...answer, requestRevision: 1, choice: 'invented' })).rejects.toThrow('prepared answer')
  expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toHaveLength(0)
  expect(await ctx.mydotHandoff.cancel(view.request.requestId)).toMatchObject({ phase: 'retired' })
  expect(await ctx.mydotHandoff.cancel(view.request.requestId)).toMatchObject({ phase: 'retired' })
})

const humanToolInput = (id: string) => ({ request_id: id, question: 'Confirm the public result', reason: 'Only the owner can decide this',
  evidence_url: '', resume_instruction: 'Continue the original work', options: [] })

it('serializes a retry behind a still-pending failed durability operation', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const origin = await ctx.agentLoop.create(SessionId('serialization-failure'))
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async () => {
    entered.resolve(undefined); await finish.promise; throw new Error('first durability failed')
  })
  const input = { requestId: 'serialization-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null }
  const first = ctx.mydotHandoff.prepare(origin, input)
  const failure = expect(first).rejects.toThrow('first durability')
  await entered.promise
  const second = ctx.mydotHandoff.prepare(origin, input)
  finish.resolve(undefined)
  await failure
  expect(await second).toMatchObject({ phase: 'pending' })
  expect(origin.session.snapshotEvents().filter(event => event.type === 'mydot/human-handoff')).toHaveLength(1)
})

it('refuses answering through an unavailable live projection instead of dispatching from a lookup cache', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const origin = await ctx.agentLoop.create(SessionId('missing-live-projection'))
  const view = await ctx.mydotHandoff.prepare(origin, { requestId: 'live-projection', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValueOnce(undefined)
  await expect(ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'projection-answer', choice: 'confirmed', text: '', result: null }))).rejects.toThrow('not found')
  expect([...origin.inbox.nextTurn, ...origin.inbox.nextStep]).toHaveLength(0)
})

it('publishes no parent request when the direct-child durability barrier fails', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const parent = await ctx.agents.create({ sessionId: SessionId('child-barrier-parent') })
  const child = await ctx.agents.create({ sessionId: SessionId('child-barrier'), parentAgent: parent.agent })
  vi.spyOn(ctx.sessions, 'flush').mockResolvedValueOnce(false)
  await expect(ctx.mydotHandoff.prepare(child.agent, { requestId: 'child-barrier-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })).rejects.toThrow('durable')
  expect(parent.agent.session.snapshotEvents().filter(event => event.type === 'mydot/human-handoff')).toHaveLength(0)
  expect(await ctx.mydotHandoff.snapshot()).toHaveLength(0)
})

it('bounds the complete owner answer in UTF-8 bytes before it is persisted or dispatched', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true, maxTextBytes: 2000 })
  const origin = await ctx.agentLoop.create(SessionId('answer-byte-bound'))
  const view = await ctx.mydotHandoff.prepare(origin, { requestId: 'answer-byte-review', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  await expect(ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1,
    submissionId: 'oversized-answer', choice: 'confirmed', text: '日本語'.repeat(1000), result: null }))).rejects.toThrow('byte allowance')
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('pending')
  expect([...origin.inbox.nextTurn, ...origin.inbox.nextStep]).toHaveLength(0)
})

it('does not claim cancellation after the answer was dispatched to its original Session', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('already-dispatched answer consumed')]))
  const origin = await ctx.agentLoop.create(SessionId('cancel-after-dispatch'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const view = await ctx.mydotHandoff.prepare(origin, { requestId: 'cancel-dispatched', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'dispatched-answer', choice: 'confirmed', text: '', result: null }))
  await expect(ctx.mydotHandoff.cancel(view.request.requestId)).rejects.toThrow('original Session')
  await origin.whenIdle()
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('resumed')
})

it('suppresses a retired answer while allowing fresh owner input in the same batch', async () => {
  const { ctx } = await setup({ humanHandoffEnabled: true })
  const origin = await ctx.agentLoop.create(SessionId('retired-input-batch'))
  const view = await ctx.mydotHandoff.prepare(origin, { requestId: 'retired-batch', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  const rpcId = 'handoff:retired-batch:1'
  origin.session.append('mydot/human-handoff', { kind: 'dispatching', requestId: view.request.requestId, rpcId })
  origin.session.append('mydot/human-handoff', { kind: 'stopped', requestId: view.request.requestId, reason: 'Unknown dispatch' })
  await ctx.mydotHandoff.cancel(view.request.requestId)
  const old = createUserMessage({ source: { kind: 'user', rpcId }, content: [{ type: 'text', text: 'Old answer' }] })
  const fresh = message('New explicitly authorized work')
  const run = (messages: UserMessage[]) => agentEvents(ctx, origin).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal: signal() }, async () => ({ kind: 'enter', messages: [...messages] }))
  expect(await run([old])).toMatchObject({ kind: 'reject' })
  const result = await run([old, fresh])
  expect(result).toMatchObject({ kind: 'enter', messages: [fresh] })
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('retired')
})

it.each(['cold', 'live', 'admission'] as const)('preserves the prepared consumed-round floor before continuation (%s)', async (mode) => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  await ctx.plugin(Goals)
  const adapter = new MockAdapter([textResponse('unexpected budget-reset continuation')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agents.create({ sessionId: SessionId(`round-floor-parent-${mode}`), meta: { cwd: root } })
  const source = await ctx.agents.create({ sessionId: SessionId(`round-floor-${mode}`),
    ...mode === 'cold' ? { parentAgent: parent.agent } : {}, meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' } })
  const goal = ctx.goals.create(source.agent, { objective: 'Bounded original work', maxGoalRounds: 2 })
  source.agent.session.append('turn/start', { turn: 1 })
  source.agent.session.append('user/message', createUserMessage({ source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 }, content: [] }), { surfaceOp: 'append' })
  source.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const flush = vi.spyOn(ctx.sessions, 'flush')
  const view = await ctx.mydotHandoff.prepare(source.agent, { requestId: `round-floor-review-${mode}`, question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  expect(view.request.goal?.roundsStarted).toBe(1)
  if (mode === 'cold') {
    expect(flush.mock.calls.map(([session]) => session.id)).toEqual([source.agent.id, parent.agent.id])
    await source.dispose()
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (id, options) => {
      const observed = await observe(id, options)
      const projection = observed.projections
      const saved = projection?.values.goal
      if (id !== source.agent.id || projection === undefined || saved === undefined || saved === null) return observed
      return { ...observed, projections: { ...projection, values: { ...projection.values, goal: { ...saved, roundsStarted: 0 } } } }
    })
  } else {
    const current = ctx.goals.get(source.agent)!
    const regress = () => { vi.spyOn(ctx.goals, 'get').mockReturnValueOnce({ ...current, roundsStarted: 0 }) }
    if (mode === 'live') regress()
    else ctx.on('agent/pre-step', async (_input, next) => { const result = await next(); regress(); return result })
  }
  const receipt = await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: `round-floor-answer-${mode}`, choice: 'confirmed', text: '', result: null }))
  if (mode !== 'cold') await source.agent.whenIdle()
  expect((await ctx.mydotHandoff.snapshot()).find(item => item.request.requestId === view.request.requestId)?.phase).toBe('stopped')
  if (mode !== 'admission') expect(receipt.rpcId).toBeUndefined()
  expect(adapter.requests).toHaveLength(0)
})

it('records an artifact outcome when the original Session uses the configured default directory', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  const artifact = join(root, 'default-result.md')
  await writeFile(artifact, 'public result')
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('default-directory answer consumed')]))
  const origin = await ctx.agentLoop.create(SessionId('default-human-outcome'), { provider: 'mock', model: 'mock' })
  const view = await ctx.mydotHandoff.prepare(origin, { requestId: 'default-outcome', question: 'Choose?', reason: 'Owner decision', evidenceUrl: '', resumeInstruction: 'Continue', options: [], target: null })
  await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: 'default-answer', choice: 'confirmed', text: '', result: null }))
  await origin.whenIdle()
  expect(await ctx.tools.execute({ name: 'record_human_request_outcome', arguments: { request_id: view.request.requestId, outcome: 'succeeded', evidence: artifact }, callId: ToolCallId('default-outcome-call'), signal: signal(), agent: origin })).toMatchObject({ isError: false })
  await ctx.mydotHandoff.cancel(view.request.requestId)
})

it.each(['unchanged', 'cleared', 'edited', 'replaced', 'exhausted', 'projection-unavailable'] as const)('checks the saved cold-child goal before continuation (%s)', async (mode) => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  await ctx.plugin(Goals)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('ask-cold-goal', 'prepare_human_request', humanToolInput(`cold-goal-${mode}`)), textResponse('parent remains available'),
    textResponse('child answer consumed'), textResponse('parent saw child result'),
  ]))
  const parent = await ctx.agentLoop.create(SessionId(`goal-parent-${mode}`), { provider: 'mock', model: 'mock' }, { cwd: root })
  ctx.on('agent/created', ({ agent }) => {
    if (ctx.agents.isOwnedBy(agent.id, parent) && ctx.goals.get(agent) === undefined) ctx.goals.create(agent, { objective: 'Finish the reviewed result', maxGoalRounds: 1 })
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!ctx.agents.isOwnedBy(agent.id, parent)) return
    const goal = ctx.goals.get(agent)!
    if (mode === 'cleared') ctx.goals.clear(agent, goal)
    if (mode === 'edited') ctx.goals.edit(agent, goal, { objective: 'Changed work' })
    if (mode === 'replaced') { ctx.goals.complete(agent, goal); ctx.goals.create(agent, { objective: 'Replacement', maxGoalRounds: 1 }) }
    if (mode === 'exhausted') agent.session.append('user/message', createUserMessage({ source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 }, content: [] }), { surfaceOp: 'append' })
  })
  const child = await ctx.mydot.startJob({ parentSessionId: parent.id, requestId: `goal-child-${mode}` as SessionRequestId,
    label: 'Review', prompt: 'Prepare owner review', provider: 'spawn' }, signal())
  await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
  const view = (await ctx.mydotHandoff.snapshot())[0]!
  if (mode === 'projection-unavailable') {
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((id, options) => observe(id, id === child.childSessionId ? { projectionMode: 'none' } : options))
  }
  const receipt = await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1, submissionId: `answer-${mode}`, choice: 'confirmed', text: '', result: null }))
  if (mode === 'unchanged') {
    await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
    expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('resumed')
    using source = await ctx.sessionQuery.observeSession(child.childSessionId)
    expect(source.projections?.values.goal?.roundsStarted).toBe(0)
  } else { expect(receipt.phase).toBe('stopped'); expect(ctx.agents.get(child.childSessionId)).toBeUndefined() }
})

it('accepts an answer before the preparation tool settles and admits it exactly once', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('human-race', 'prepare_human_request', humanToolInput('settlement-race')), textResponse('answer consumed')]))
  const agent = await ctx.agentLoop.create(SessionId('human-race-origin'), { provider: 'mock', model: 'mock' }, { cwd: root })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name === 'prepare_human_request') {
      const view = (await ctx.mydotHandoff.snapshot())[0]!
      await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1,
        submissionId: 'early-answer', choice: 'confirmed', text: '', result: null }))
    }
    return result
  })
  agent.followup(message('Prepare the owner request'))
  await agent.whenIdle()
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('resumed')
  expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === 'handoff:settlement-race:1')).toHaveLength(1)
})

it('prepares an exact survey target through the model tool and recovers saved non-confirming results', async () => {
  const b = await surveyBench()
  b.ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('ask-survey', 'prepare_human_request', {
    ...humanToolInput('callback-review'), target: surveyTarget, evidence_url: 'https://example.test/survey',
  })]))
  const origin = await b.ctx.agentLoop.create(SessionId('tool-survey-target'), { provider: 'mock', model: 'mock' }, { cwd: b.root })
  origin.followup(message('Prepare source review'))
  await origin.whenIdle()
  expect((await b.ctx.mydotHandoff.snapshot())[0]?.request.target).toEqual(surveyTarget)
  for (const status of ['deferred', 'needs-material'] as const) {
    const id = status === 'deferred' ? 'callback-review' : 'recovery-material'
    if (status === 'needs-material') await b.ctx.mydotHandoff.prepare(origin, surveyInput(id))
    b.set({ ...surveyResult(id), status, planning: null })
    expect(await b.ctx.mydotHandoff.reconcile(id as HumanRequestId)).toMatchObject({ phase: 'stopped', answer: { choice: status } })
  }
})

it('accepts an explicit null generic target and refuses to turn a saved deferred result into confirmation', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('ask-null', 'prepare_human_request', { ...humanToolInput('null-target'), target: null })]))
  const origin = await ctx.agentLoop.create(SessionId('null-target-origin'), { provider: 'mock', model: 'mock' }, { cwd: root })
  origin.followup(message('Prepare generic owner decision'))
  await origin.whenIdle()
  expect((await ctx.mydotHandoff.snapshot())[0]).toMatchObject({ phase: 'pending', request: { target: null } })
  const b = await surveyBench()
  const other = await b.ctx.agentLoop.create(SessionId('contradictory-disposition'))
  const view = await b.ctx.mydotHandoff.prepare(other, surveyInput('callback-review'))
  const result = { ...surveyResult('callback-review'), status: 'deferred' as const }
  b.set(result)
  await expect(b.ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: 1,
    submissionId: 'contradictory-confirmation', choice: 'confirmed', text: '', result }))).rejects.toThrow('disposition')
  expect((await b.ctx.mydotHandoff.snapshot())[0]?.phase).toBe('pending')
})

it('resumes a cold direct child through its durable parent while other work progresses', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('ask-child', 'prepare_human_request', humanToolInput('child-review')),
    textResponse('parent remains available'), textResponse('independent sibling result'), textResponse('parent saw sibling result'),
    textResponse('original child consumed answer'), textResponse('parent saw original result'),
  ]))
  const parent = await ctx.agentLoop.create(SessionId('human-parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const first = await ctx.mydot.startJob({ parentSessionId: parent.id, requestId: 'human-child' as SessionRequestId,
    label: 'Owner review', prompt: 'Prepare the human request', provider: 'spawn' }, signal())
  await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
  const pending = (await ctx.mydotHandoff.snapshot())[0]!
  expect(pending.request).toMatchObject({ sessionId: first.childSessionId, parentSessionId: parent.id })
  expect(ctx.agents.get(first.childSessionId)).toBeUndefined()
  const sibling = await ctx.mydot.startJob({ parentSessionId: parent.id, requestId: 'sibling-work' as SessionRequestId,
    label: 'Independent work', prompt: 'Finish the independent public result', provider: 'spawn' }, signal())
  await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
  using siblingSource = await ctx.sessionQuery.observeSession(sibling.childSessionId)
  expect(siblingSource.events.some(event => event.type === 'assistant/message')).toBe(true)
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('pending')
  await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: pending.request.requestId, requestRevision: 1,
    submissionId: 'child-answer', choice: 'confirmed', text: '', result: null }))
  await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
  expect((await ctx.mydotHandoff.snapshot())[0]?.phase).toBe('resumed')
  using original = await ctx.sessionQuery.observeSession(first.childSessionId)
  expect(original.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === 'handoff:child-review:1')).toHaveLength(1)
})

it('refuses a paused durable goal before cold child materialization or answer delivery', async () => {
  const { ctx, root } = await setup({ humanHandoffEnabled: true })
  await ctx.plugin(Goals)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('ask-paused-child', 'prepare_human_request', humanToolInput('cold-paused-review')), textResponse('parent remains available'),
  ]))
  const parent = await ctx.agentLoop.create(SessionId('paused-parent'), { provider: 'mock', model: 'mock' }, { cwd: root })
  ctx.on('agent/created', ({ agent }) => {
    if (ctx.agents.isOwnedBy(agent.id, parent)) ctx.goals.create(agent, { objective: 'Finish the reviewed result', maxGoalRounds: 2 })
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!ctx.agents.isOwnedBy(agent.id, parent)) return
    const goal = ctx.goals.get(agent)
    if (goal?.phase === 'active') ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
  })
  const child = await ctx.mydot.startJob({ parentSessionId: parent.id, requestId: 'paused-child' as SessionRequestId,
    label: 'Paused review', prompt: 'Prepare the owner review', provider: 'spawn' }, signal())
  await ctx.subagents.waitForChildren(parent); await parent.whenIdle()
  expect(ctx.agents.get(child.childSessionId)).toBeUndefined()
  const pending = (await ctx.mydotHandoff.snapshot())[0]!
  const result = await ctx.mydotHandoff.answer(humanAnswerSchema.parse({ requestId: pending.request.requestId,
    requestRevision: 1, submissionId: 'paused-answer', choice: 'confirmed', text: '', result: null }))
  expect(result).toMatchObject({ phase: 'stopped' })
  expect(result.reason).toContain('paused')
  expect(ctx.agents.get(child.childSessionId)).toBeUndefined()
  using original = await ctx.sessionQuery.observeSession(child.childSessionId)
  expect(original.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === 'handoff:cold-paused-review:1')).toHaveLength(0)
})

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
  const content: unknown = JSON.parse(block.text.replaceAll(space.id, '<space-id>'))
  expect(content).toMatchInlineSnapshot(`
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
  expect((await watch.next()).value).toHaveProperty('spaces', [])
  const next = watch.next()
  await ctx.mydot.saveSpace(spaceInput)
  expect((await next).value).toHaveProperty('spaces.length', 1)
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
  expect((await first).value).toHaveProperty('spaces', [])
  expect((await watch.next()).value).toHaveProperty('spaces.length', 1)
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
    desktopTools: [], captureTools: ['capture'], humanHandoffEnabled: false, humanHandoffSocketPath: '', humanHandoffSurveyOrigin: '' })).toThrow('subset')
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
