/** Actual Loader, Session writer and owner UI projection with an external recorder replacement. */
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
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
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { RemoteInvocation, PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as recorder from '../src/filing-recorder.ts'
import { filingPlanSchema } from '../src/filing-state.ts'
import '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { filingGuest: { readonly kind: 'filing-guest' } } }
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function setup(existing?: { root: string; pool: MemoryMediaPool }) {
  const root = existing?.root ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-filing-loader-')))
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(TestSessionQuery)
  await liveConfig(ctx, SubagentRuntime, {}); await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(Storage)
  const pool = existing?.pool ?? new MemoryMediaPool(); const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('memory', backend))
  const facility = new DomainFacility(ctx, { backend: 'memory' }); ctx.provide('storageDomain', facility)
  ctx.effect(() => async () => { await facility.closeAll(); await backend.close() })
  ctx.provide('sessionController', { resolveAgent: async (id: SessionId) => ({ agent: (await ctx.agents.resume({
    resumeSessionId: id, agentOptions: {}, signal: new AbortController().signal,
  })).agent }) } as never)
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([{ name: '@deepseek-ai/dsh-experimental-mydot', config: { memoryDirectory: join(root, 'memory'), filingEnabled: true,
    filingRecorderSocketPath: '/private/mock-recorder.sock', filingRecorderTimeoutMs: 1000, filingRecorderMaxAgeMs: 1000 } }]))
  ctx.baseUrl = pathToFileURL(root).href + '/'; ctx.loader.builtins.include = Include; ctx.loader.internal = undefined
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } }); await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  vi.spyOn(recorder, 'readRecorderStatus').mockImplementation(async (_config, caseId, planDigest) => ({
    version: 'high-impact-recorder/v1', caseId, planDigest, state: 'recording', evidence: 'partial', readyForConfirmation: true,
    sequence: 1, observedAt: Date.now(), archiveRef: 'archive-1', segments: ['segment-1'], gaps: ['gap-1'], protectedIntervals: ['protected-1'],
  }))
  return { ctx, root, pool }
}
async function prepared(runtime: Awaited<ReturnType<typeof setup>>) {
  const { ctx, root } = runtime
  const agent = await ctx.agentLoop.create(SessionId('original-filing'), {}, { cwd: root })
  const caseId = await ctx.mydotFiling.startCase(agent)
  await writeFile(join(root, 'source.txt'), 'public source'); await writeFile(join(root, 'preview.txt'), 'public preview')
  const file = (role: 'source' | 'preview', text: string) => ({ role, path: `${role}.txt`, digest: createHash('sha256').update(text).digest('hex') })
  const plan = filingPlanSchema.parse({ caseId, legalEntity: 'Mock Entity', account: 'mock-account', site: 'local-synthetic-recipient',
    period: { from: '2025-01-01', to: '2025-12-31' }, tax: 'mock-tax', destination: 'mock-local', amount: '1000', currency: 'JPY', forms: ['mock-return'],
    files: [file('source', 'public source'), file('preview', 'public preview')], inputDestinations: ['local-preview'], modelDestinations: [],
    expiresAt: Date.now() + 60000, stopRef: 'owner-cancel', queryRef: 'mock-query', effects: { submit: true, payment: 'none', standingSettings: 'none' } })
  const view = await ctx.mydotFiling.prepare(agent, plan)
  return { agent, view }
}
it('composes one owner decision, fences all Session tools and projects accepted plus recording gap', async () => {
  const runtime = await setup(); const { ctx } = runtime; const { agent, view } = await prepared(runtime)
  const child = await ctx.agentLoop.create(SessionId('child-filing'), {})
  await expect(ctx.mydotFiling.prepare(child, view.plan)).rejects.toThrow(/Reserve|another/)
  const bodies = vi.fn()
  for (const name of ['shell-fixture', 'capture-fixture', 'browser-fixture']) ctx.tools.register(defineContentToolFixture({ name,
    description: 'Synthetic control body', parameters: {}, execute: async () => { bodies(); return [{ type: 'text', text: 'operated' }] } }))
  await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  await ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)
  for (const caller of [agent, child, undefined]) for (const name of ['shell-fixture', 'capture-fixture', 'browser-fixture']) {
    const result = await ctx.tools.execute({ name, arguments: {}, callId: ToolCallId(`call-${caller?.id ?? 'host'}-${name}`), signal: new AbortController().signal,
      ...(caller === undefined ? {} : { agent: caller }) })
    expect(result.isError).toBe(true)
  }
  expect(bodies).not.toHaveBeenCalled()
  await Promise.all([ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest),
    ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest)])
  using source = await ctx.sessionQuery.observeSession(agent.id)
  expect(source.events.filter(event => event.type === 'mydot/mock-receipt')).toHaveLength(1)
  const cards = (await ctx.mydot.snapshot()).filings!
  expect(cards.map(card => ({ phase: card.filing.phase, actor: card.filing.actor, revision: card.filing.revision,
    recording: card.filing.recorder?.evidence, gaps: card.filing.recorder?.gaps, forms: card.filing.receipt?.forms,
    ready: card.confirmationReady }))).toMatchInlineSnapshot(`
    [
      {
        "actor": "host-owner",
        "forms": [
          "mock-return",
        ],
        "gaps": [
          "gap-1",
        ],
        "phase": "accepted",
        "ready": false,
        "recording": "partial",
        "revision": 1,
      },
    ]
  `)
})
it('denies guest approvals and hides owner filings from their snapshot', async () => {
  const runtime = await setup(); const { ctx } = runtime; const { view } = await prepared(runtime)
  const signal = new AbortController().signal
  const invocation: RemoteInvocation = { request: { namespace: 'mydotFiling', method: 'approve', args: {} }, service: 'mydotFiling', signal,
    peer: { id: 'filing-guest' as PeerId, ctx, principal: { kind: 'filing-guest' }, interactions: 'answer', signal, dispose: async () => {} }, uplink: async function* () {} }
  const guest = ctx.extend({ invocation })
  for (const action of ['approve', 'confirmMock', 'cancel'] as const) await expect(guest.mydotFiling[action](view.plan.caseId, view.revision, view.planDigest)).rejects.toThrow(/Host owner/)
  await expect(guest.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)).rejects.toThrow(/Host owner/)
  await expect(guest.mydotFiling.reconcile(view.plan.caseId)).rejects.toThrow(/Host owner/)
  expect((await guest.mydot.snapshot()).filings).toEqual([])
})
it('restores an unconsumed intent as query-only and never enables confirmation after restart', async () => {
  const first = await setup(); const { view } = await prepared(first)
  await first.ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  await first.ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)
  await first.ctx.fiber.dispose(); vi.restoreAllMocks()
  const second = await setup(first)
  expect((await second.ctx.mydot.snapshot()).filings?.[0]?.confirmationReady).toBe(false)
  await expect(second.ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest)).rejects.toThrow(/never resend/)
  expect((await second.ctx.mydotFiling.reconcile(view.plan.caseId)).phase).toBe('intent')
})
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import Goals from '@deepseek-ai/dsh-goal'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { FilingService } from '../src/filing-service.ts'
import type { Config } from '../src/index.ts'

type FilingRuntime = Awaited<ReturnType<typeof setup>>
type PreparedFiling = Awaited<ReturnType<typeof prepared>>
let filingToolSequence = 0

function filingEntry(ctx: Context) {
  const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-experimental-mydot')
  if (entry === undefined) throw new Error('The MyDot Loader entry is required')
  return entry
}

async function reloadFiling(runtime: FilingRuntime, overrides: Partial<Config> = {}): Promise<void> {
  const entry = filingEntry(runtime.ctx)
  await entry.update({ disabled: true })
  await entry.update({ disabled: false, config: {
    memoryDirectory: join(runtime.root, 'memory'), filingEnabled: true,
    filingRecorderSocketPath: '/private/mock-recorder.sock', filingRecorderTimeoutMs: 1000, filingRecorderMaxAgeMs: 1000,
    ...overrides,
  } })
  await entry.fiber!.await()
  await runtime.ctx.mydotFiling.snapshot()
}

async function anotherFiling(runtime: FilingRuntime, original: PreparedFiling, agent = original.agent): Promise<PreparedFiling> {
  const caseId = await runtime.ctx.mydotFiling.startCase(agent)
  const view = await runtime.ctx.mydotFiling.prepare(agent, { ...original.view.plan, caseId })
  return { agent, view }
}

function filingTool(ctx: Context, name: string, agent: PreparedFiling['agent'] | undefined, args: Record<string, unknown> = {}) {
  return ctx.tools.execute({ name, arguments: args, ...(agent === undefined ? {} : { agent }), signal: new AbortController().signal,
    callId: ToolCallId((++filingToolSequence).toString(16).padStart(32, '0')) })
}

function stoppedFilingRecorder(): void {
  vi.mocked(recorder.readRecorderStatus).mockImplementation(async (_config, caseId, planDigest) => ({
    version: 'high-impact-recorder/v1', caseId, planDigest, state: 'stopped', evidence: 'partial', readyForConfirmation: false,
    sequence: 2, observedAt: Date.now(), archiveRef: 'archive-1', segments: ['segment-1'], gaps: ['gap-1'], protectedIntervals: ['protected-1'],
  }))
}

async function filingDesktopStopping(ctx: Context, signal: AbortSignal) {
  for await (const snapshot of ctx.mydot.watch(signal)) {
    if (snapshot.desktop.phase === 'stopping') return snapshot.desktop
  }
  throw new Error('Desktop observation ended before takeover reached stopping')
}

type OptionalRecorderSetting = 'filingRecorderSocketPath' | 'filingRecorderTimeoutMs' | 'filingRecorderMaxAgeMs'
const invalidFilingConfigurations: Array<[string, Partial<Config>, OptionalRecorderSetting?]> = [
  ['missing socket', {}, 'filingRecorderSocketPath'],
  ['empty socket', { filingRecorderSocketPath: '' }],
  ['relative socket', { filingRecorderSocketPath: 'recorder.sock' }],
  ['missing deadline', {}, 'filingRecorderTimeoutMs'],
  ['zero deadline', { filingRecorderTimeoutMs: 0 }],
  ['negative deadline', { filingRecorderTimeoutMs: -1 }],
  ['fractional deadline', { filingRecorderTimeoutMs: 1.5 }],
  ['non-finite deadline', { filingRecorderTimeoutMs: Number.POSITIVE_INFINITY }],
  ['deadline beyond the timer range', { filingRecorderTimeoutMs: 2_147_483_648 }],
  ['missing freshness limit', {}, 'filingRecorderMaxAgeMs'],
  ['zero freshness limit', { filingRecorderMaxAgeMs: 0 }],
  ['negative freshness limit', { filingRecorderMaxAgeMs: -1 }],
  ['fractional freshness limit', { filingRecorderMaxAgeMs: 1.5 }],
  ['unsafe freshness limit', { filingRecorderMaxAgeMs: Number.MAX_SAFE_INTEGER + 1 }],
]

it.each(invalidFilingConfigurations)('rejects enabled filing with %s before registering tools', (_label, overrides, omitted) => {
  const ctx = new Context()
  contexts.push(ctx)
  const config: ConstructorParameters<typeof FilingService>[1] = {
    maxTextBytes: 4096, filingEnabled: true, filingRecorderSocketPath: '/private/mock-recorder.sock',
    filingRecorderTimeoutMs: 1000, filingRecorderMaxAgeMs: 1000,
    takeover: async () => {}, returnControl: async () => {}, read: async () => '', ...overrides,
  }
  if (omitted !== undefined) Reflect.deleteProperty(config, omitted)
  expect(() => new FilingService(ctx, config)).toThrow('Synthetic filing requires a fixed recorder socket and explicit positive request deadline and freshness limit')
})

it('keeps durable filing history decoded while disabling preparation, owner commands and model tools', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  const before = agent.session.snapshotEvents()
  await reloadFiling(runtime, { filingEnabled: false })
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect(ctx.sessionProjections.stateOf(agent.session, 'mydotFilings')).toEqual([view])
  expect(await ctx.mydotFiling.snapshot()).toEqual([])
  expect((await ctx.mydot.snapshot()).filings).toEqual([])
  expect(ctx.tools.get('start_mock_filing_case')).toBeUndefined()
  expect(ctx.tools.get('prepare_mock_filing')).toBeUndefined()
  const commands = [
    () => ctx.mydotFiling.startCase(agent),
    () => ctx.mydotFiling.prepare(agent, view.plan),
    () => ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest),
    () => ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true),
    () => ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest),
    () => ctx.mydotFiling.cancel(view.plan.caseId, view.revision, view.planDigest),
    () => ctx.mydotFiling.reconcile(view.plan.caseId),
    () => ctx.mydotFiling.returnControl(view.plan.caseId, view.revision, view.planDigest),
  ]
  for (const command of commands) await expect(command()).rejects.toThrow('Synthetic filing is disabled')
  expect(agent.session.snapshotEvents()).toEqual(before)
})

it('denies every owner decision and direct filing snapshot to an authenticated guest', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  const signal = new AbortController().signal
  const invocation: RemoteInvocation = {
    request: { namespace: 'mydotFiling', method: 'returnControl', args: {} }, service: 'mydotFiling', signal,
    peer: { id: 'filing-guest' as PeerId, ctx, principal: { kind: 'filing-guest' }, interactions: 'answer', signal, dispose: async () => {} },
    uplink: async function* () {},
  }
  const guest = ctx.extend({ invocation })
  const before = agent.session.snapshotEvents()
  const commands = [
    () => guest.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest),
    () => guest.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true),
    () => guest.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest),
    () => guest.mydotFiling.cancel(view.plan.caseId, view.revision, view.planDigest),
    () => guest.mydotFiling.reconcile(view.plan.caseId),
    () => guest.mydotFiling.returnControl(view.plan.caseId, view.revision, view.planDigest),
  ]
  for (const command of commands) await expect(command()).rejects.toThrow('Only the authenticated Host owner')
  expect(await guest.mydotFiling.snapshot()).toEqual([])
  expect((await guest.mydot.snapshot()).filings).toEqual([])
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect(recorder.readRecorderStatus).not.toHaveBeenCalled()
})

it('does not reserve app control for a false owner assertion and admits only one subsequent case', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const first = await prepared(runtime)
  const second = await anotherFiling(runtime, first)
  for (const { view } of [first, second]) await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  const before = first.agent.session.snapshotEvents()
  await expect(ctx.mydotFiling.begin(first.view.plan.caseId, first.view.revision, first.view.planDigest, false)).rejects.toThrow('The owner must confirm')
  expect(first.agent.session.snapshotEvents()).toEqual(before)
  expect(recorder.readRecorderStatus).not.toHaveBeenCalled()
  const admitted = await ctx.mydotFiling.begin(second.view.plan.caseId, second.view.revision, second.view.planDigest, true)
  expect(admitted).toMatchObject({ phase: 'intent', control: 'human', ownerControlConfirmation: {
    revision: second.view.revision, planDigest: second.view.planDigest, source: 'host-owner',
  } })
  const admittedEvents = first.agent.session.snapshotEvents()
  expect(await ctx.mydotFiling.begin(second.view.plan.caseId, second.view.revision, second.view.planDigest, true)).toEqual(admitted)
  expect(first.agent.session.snapshotEvents()).toEqual(admittedEvents)
  await expect(ctx.mydotFiling.begin(first.view.plan.caseId, first.view.revision, first.view.planDigest, true)).rejects.toThrow('Another case owns app control')
  await expect(ctx.mydotFiling.returnControl(first.view.plan.caseId, first.view.revision, first.view.planDigest)).rejects.toThrow('Another case owns app control')
  await ctx.mydotFiling.cancel(second.view.plan.caseId, second.view.revision, second.view.planDigest)
  const recording = vi.mocked(recorder.readRecorderStatus).getMockImplementation()!
  stoppedFilingRecorder()
  expect(await ctx.mydotFiling.returnControl(second.view.plan.caseId, second.view.revision, second.view.planDigest)).toMatchObject({ control: 'return-authorized' })
  vi.mocked(recorder.readRecorderStatus).mockImplementation(recording)
  expect(await ctx.mydotFiling.begin(first.view.plan.caseId, first.view.revision, first.view.planDigest, true)).toMatchObject({ phase: 'intent' })
})

it.each(['return-first', 'takeover-first'] as const)('serializes a delayed duplicate return with the next takeover (%s)', async (order) => {
  const runtime = await setup()
  const { ctx } = runtime
  const first = await prepared(runtime)
  const second = await anotherFiling(runtime, first)
  for (const { view } of [first, second]) await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  await ctx.mydotFiling.begin(first.view.plan.caseId, first.view.revision, first.view.planDigest, true)
  await ctx.mydotFiling.cancel(first.view.plan.caseId, first.view.revision, first.view.planDigest)
  const source = await ctx.mydot.readFile(first.agent.id, 'source.txt')
  const preview = await ctx.mydot.readFile(first.agent.id, 'preview.txt')
  vi.spyOn(ctx.mydot, 'readFile').mockImplementation(async (_session, path) => path === 'source.txt' ? source : preview)
  vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  const recording = vi.mocked(recorder.readRecorderStatus).getMockImplementation()!
  let returns = 0
  vi.mocked(recorder.readRecorderStatus).mockImplementation(async (config, caseId, digest) => {
    if (caseId === first.view.plan.caseId && ++returns === 2) {
      entered.resolve(undefined); await finish.promise
    }
    const status = await recording(config, caseId, digest)
    return caseId === first.view.plan.caseId
      ? { ...status, state: 'stopped', readyForConfirmation: false, sequence: 2 } : status
  })
  const body = vi.fn()
  ctx.tools.register(defineContentToolFixture({ name: 'filing-duplicate-return-probe', description: '', parameters: {}, execute: async () => {
    body(); return [{ type: 'text', text: 'ordinary app control' }]
  } }))
  const returning = () => ctx.mydotFiling.returnControl(first.view.plan.caseId, first.view.revision, first.view.planDigest)
  const firstReturn = returning()
  let duplicate: ReturnType<typeof returning> | undefined
  let duplicateResult: Promise<PromiseSettledResult<PreparedFiling['view']>[]> | undefined
  let beginning: Promise<PreparedFiling['view']> | undefined
  try {
    if (order === 'return-first') {
      duplicate = returning(); duplicateResult = Promise.allSettled([duplicate])
      await firstReturn; await entered.promise
      beginning = ctx.mydotFiling.begin(second.view.plan.caseId, second.view.revision, second.view.planDigest, true)
    } else {
      await firstReturn
      beginning = ctx.mydotFiling.begin(second.view.plan.caseId, second.view.revision, second.view.planDigest, true)
      duplicate = returning(); duplicateResult = Promise.allSettled([duplicate])
    }
    // All adapters now resolve immediately except the controlled recorder response.
    await new Promise<void>(resolve => setImmediate(resolve))
    finish.resolve(undefined)
    expect(await beginning).toMatchObject({ phase: 'intent', control: 'human' })
    const [result] = await duplicateResult
    expect(result?.status).toBe(order === 'return-first' ? 'fulfilled' : 'rejected')
    expect((await filingTool(ctx, 'filing-duplicate-return-probe', first.agent)).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
    await expect(returning()).rejects.toThrow('Another case owns app control')
  } finally {
    finish.resolve(undefined)
    await Promise.allSettled([firstReturn, duplicate, beginning])
  }
})

it('requires an original-Session reservation even when another Session copies the reservation and plan', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const original = await prepared(runtime)
  const other = await ctx.agentLoop.create(SessionId('1'.repeat(32)), {}, { cwd: runtime.root })
  other.session.append('mydot/filing-case', { caseId: original.view.plan.caseId, sessionId: original.agent.id })
  await ctx.sessions.flush(other.session)
  await expect(ctx.mydotFiling.prepare(other, original.view.plan)).rejects.toThrow('Reserve the case in this original Session')
  other.session.append('mydot/filing-case', { caseId: original.view.plan.caseId, sessionId: other.id })
  await ctx.sessions.flush(other.session)
  await expect(ctx.mydotFiling.prepare(other, original.view.plan)).rejects.toThrow('Case belongs to another original Session')
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  const observation = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((id, options) => observe(id, { ...options, projectionMode: 'none' }))
  try {
    await expect(ctx.mydotFiling.prepare(other, original.view.plan)).rejects.toThrow('Case belongs to another original Session')
  } finally { observation.mockRestore() }
  expect(other.session.snapshotEvents().filter(event => event.type === 'mydot/filing')).toHaveLength(0)
  const before = original.agent.session.snapshotEvents()
  expect(await ctx.mydotFiling.prepare(original.agent, original.view.plan)).toEqual(original.view)
  expect(original.agent.session.snapshotEvents()).toEqual(before)
  const revised = await ctx.mydotFiling.prepare(original.agent, { ...original.view.plan, amount: '1001' })
  expect(revised).toMatchObject({ revision: 2, phase: 'prepared', actor: 'model-preparer', previousPlan: original.view.plan })
  expect(revised.planDigest).not.toBe(original.view.planDigest)
})

it('does not approve a cached workflow when its current filing projection is unavailable', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  const before = agent.session.snapshotEvents()
  const state = vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValueOnce(undefined)
  try {
    await expect(ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)).rejects.toThrow('Filing not found')
  } finally { state.mockRestore() }
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect(recorder.readRecorderStatus).not.toHaveBeenCalled()
  expect(await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)).toMatchObject({ phase: 'approved' })
})

it('does not invent filing cards or owner authority when an observation contains no projections', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const { view } = await prepared(runtime)
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  const observation = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((id, options) => observe(id, { ...options, projectionMode: 'none' }))
  try {
    await reloadFiling(runtime)
    expect(await ctx.mydotFiling.snapshot()).toEqual([])
    await expect(ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)).rejects.toThrow('Filing not found')
  } finally { observation.mockRestore() }
  expect(await ctx.mydotFiling.snapshot()).toEqual([{ filing: view, confirmationReady: false }])
  expect(await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)).toMatchObject({ phase: 'approved' })
  const absent = filingPlanSchema.parse({ ...view.plan, caseId: '0'.repeat(32) }).caseId
  await expect(ctx.mydotFiling.reconcile(absent)).rejects.toThrow('Filing not found')
})

it('reads source documents through the initiating Session and rejects missing material before persisting a plan', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  const caseId = await ctx.mydotFiling.startCase(agent)
  const plan = { ...view.plan, caseId, files: view.plan.files.map(file => file.role === 'source' ? { ...file, path: 'absent-source.txt' } : file) }
  const before = agent.session.snapshotEvents()
  await expect(ctx.mydotFiling.prepare(agent, plan)).rejects.toThrow('Filing source or preview is missing')
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect((await ctx.mydotFiling.snapshot()).map(card => card.filing.plan.caseId)).toEqual([view.plan.caseId])
})

it.each(['unconfirmed', 'rejected'] as const)('does not return a case reservation after an %s durable flush', async (failure) => {
  const runtime = await setup()
  const { ctx } = runtime
  const agent = await ctx.agentLoop.create(SessionId('2'.repeat(32)), {}, { cwd: runtime.root })
  const error = new Error('reservation storage failed')
  const flush = vi.spyOn(ctx.sessions, 'flush')
  if (failure === 'unconfirmed') flush.mockResolvedValueOnce(false)
  else flush.mockRejectedValueOnce(error)
  try {
    const reservation = ctx.mydotFiling.startCase(agent)
    if (failure === 'unconfirmed') await expect(reservation).rejects.toThrow('Case reservation requires durable Session persistence')
    else await expect(reservation).rejects.toBe(error)
  } finally { flush.mockRestore() }
  expect(agent.session.snapshotEvents().filter(event => event.type === 'mydot/filing')).toHaveLength(0)
  const caseId = await ctx.mydotFiling.startCase(agent)
  expect(caseId).toMatch(/^[a-f0-9]{32}$/)
  const reservations = agent.session.snapshotEvents().filter(event => event.type === 'mydot/filing-case')
  expect(reservations).toHaveLength(2)
  expect(new Set(reservations.map(event => event.data.caseId)).size).toBe(2)
  expect(reservations.at(-1)?.data).toEqual({ caseId, sessionId: agent.id })
})

it.each([
  ['prepare', 'unconfirmed'], ['prepare', 'rejected'], ['approve', 'unconfirmed'], ['approve', 'rejected'],
] as const)('quarantines the case after %s persistence is %s', async (operation, failure) => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  const changed = vi.fn()
  ctx.on('mydot/handoff-changed', changed)
  const error = new Error('filing storage failed')
  const flush = vi.spyOn(ctx.sessions, 'flush')
  if (failure === 'unconfirmed') flush.mockResolvedValueOnce(false)
  else flush.mockRejectedValueOnce(error)
  try {
    const work = operation === 'prepare'
      ? ctx.mydotFiling.prepare(agent, { ...view.plan, amount: '1001' })
      : ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
    if (failure === 'unconfirmed') await expect(work).rejects.toThrow('Filing requires durable Session persistence')
    else await expect(work).rejects.toBe(error)
  } finally { flush.mockRestore() }
  expect(changed).not.toHaveBeenCalled()
  const cards = await ctx.mydotFiling.snapshot()
  expect(cards).toHaveLength(1)
  expect(cards[0]?.filing.phase).toBe('invalidated')
  expect(cards[0]?.filing.reason).toBe('persistence-unconfirmed')
  expect(cards[0]?.filing.plan.caseId).toBe(view.plan.caseId)
  expect(cards[0]?.confirmationReady).toBe(false)
  await expect(ctx.mydotFiling.prepare(agent, view.plan)).rejects.toThrow('Filing persistence is unconfirmed')
  await expect(ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)).rejects.toThrow('Filing persistence is unconfirmed')
  await expect(ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)).rejects.toThrow('Filing persistence is unconfirmed')
  await expect(ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest)).rejects.toThrow('Filing persistence is unconfirmed')
  await expect(ctx.mydotFiling.reconcile(view.plan.caseId)).rejects.toThrow('Filing persistence is unconfirmed')
  expect(agent.session.snapshotEvents().filter(event => event.type === 'mydot/mock-receipt')).toHaveLength(0)
})

it('does not confirm a synthetic effect when receipt-query durability is unconfirmed', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  await ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)
  const before = agent.session.snapshotEvents()
  const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValueOnce(false)
  try {
    await expect(ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest)).rejects.toThrow('Receipt durability is unconfirmed')
  } finally { flush.mockRestore() }
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect(await ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest)).toMatchObject({ phase: 'accepted' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'mydot/mock-receipt')).toHaveLength(1)
})

it.each(['unconfirmed', 'rejected'] as const)('recovers an %s synthetic callback flush by querying its sole persisted receipt', async (failure) => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  await ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)
  const persist = ctx.sessions.flush.bind(ctx.sessions)
  let intercepted = false
  const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (!intercepted && session === agent.session && session.snapshotEvents().at(-1)?.type === 'mydot/mock-receipt') {
      intercepted = true
      if (failure === 'unconfirmed') return false
      throw new Error('receipt callback storage failed')
    }
    return persist(session)
  })
  try {
    expect(await ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest)).toMatchObject({ phase: 'unknown', reason: 'confirmation-unknown' })
    expect(intercepted).toBe(true)
  } finally { flush.mockRestore() }
  expect((await ctx.mydotFiling.snapshot())[0]?.confirmationReady).toBe(false)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'mydot/mock-receipt')).toHaveLength(1)
  await ctx.sessions.flush(agent.session)
  await reloadFiling(runtime)
  const recovered = await ctx.mydotFiling.reconcile(view.plan.caseId)
  expect(recovered).toMatchObject({ phase: 'accepted', receipt: { caseId: view.plan.caseId, planDigest: view.planDigest, forms: view.plan.forms } })
  expect(await ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest)).toEqual(recovered)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'mydot/mock-receipt')).toHaveLength(1)
})

it('uses a matching receipt discovered at the final durability checkpoint without appending a duplicate', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  const intent = await ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)
  if (intent.intentId === undefined) throw new Error('The durable intent identity is required')
  const receipt = { receiptId: 'a'.repeat(32), intentId: intent.intentId, caseId: view.plan.caseId, planDigest: view.planDigest, forms: view.plan.forms }
  const persist = ctx.sessions.flush.bind(ctx.sessions)
  let inserted = false
  const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    const last = session.snapshotEvents().at(-1)
    if (!inserted && session === agent.session && last?.type === 'mydot/filing' && last.data.view.phase === 'unknown') {
      inserted = true
      session.append('mydot/mock-receipt', receipt)
    }
    return persist(session)
  })
  try {
    expect(await ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest)).toMatchObject({ phase: 'accepted', receipt })
  } finally { flush.mockRestore() }
  expect(inserted).toBe(true)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'mydot/mock-receipt').map(event => event.data)).toEqual([receipt])
})

it('resolves a cold filing only through its original writer and propagates a writer-resolution failure', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const original = await prepared(runtime)
  const cold = await ctx.agents.create({ sessionId: SessionId('3'.repeat(32)), meta: { cwd: runtime.root } })
  const { view } = await anotherFiling(runtime, original, cold.agent)
  await cold.dispose()
  await reloadFiling(runtime)
  expect(ctx.sessions.get(cold.agent.id)).toBeUndefined()
  const error = new RemoteError('session/not-found', 'Original filing writer is unavailable', { sessionId: cold.agent.id })
  const failed = vi.spyOn(ctx.sessionController, 'resolveAgent').mockResolvedValueOnce({ error })
  try {
    await expect(ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)).rejects.toBe(error)
    expect(failed).toHaveBeenCalledWith(cold.agent.id)
  } finally { failed.mockRestore() }
  const resumed = vi.spyOn(ctx.sessionController, 'resolveAgent')
  try {
    expect(await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)).toMatchObject({ sessionId: cold.agent.id, phase: 'approved' })
    expect(resumed).toHaveBeenCalledWith(cold.agent.id)
    expect(ctx.agents.get(cold.agent.id)?.session.snapshotEvents().filter(event => event.type === 'mydot/filing').at(-1)).toMatchObject({ data: { view: { phase: 'approved' } } })
  } finally { resumed.mockRestore() }
  expect(original.agent.session.snapshotEvents().filter(event => event.type === 'mydot/filing')).toHaveLength(1)
})

it('ignores copied owner-control views in a different Session during recovery, lookup and owner snapshots', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const original = await prepared(runtime)
  const other = await ctx.agentLoop.create(SessionId('4'.repeat(32)), {}, { cwd: runtime.root })
  other.session.append('mydot/filing', { view: { ...original.view, control: 'human' } })
  await ctx.sessions.flush(other.session)
  await reloadFiling(runtime)
  expect(await ctx.mydotFiling.snapshot()).toEqual([{ filing: original.view, confirmationReady: false }])
  const body = vi.fn()
  ctx.tools.register(defineContentToolFixture({ name: 'filing-copy-probe', description: '', parameters: {}, execute: async () => {
    body(); return [{ type: 'text', text: 'ordinary app control' }]
  } }))
  expect((await filingTool(ctx, 'filing-copy-probe', other)).isError).toBe(false)
  expect(body).toHaveBeenCalledOnce()
  expect(await ctx.mydotFiling.cancel(original.view.plan.caseId, original.view.revision, original.view.planDigest)).toMatchObject({ sessionId: original.agent.id, phase: 'cancelled' })
  expect(other.session.snapshotEvents().filter(event => event.type === 'mydot/filing')).toHaveLength(1)
})

it.each(['human', 'stopping'] as const)('recovers persisted %s control as fenced and query-only, then recovers explicit return authority', async (control) => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  const body = vi.fn()
  ctx.tools.register(defineContentToolFixture({ name: 'filing-recovery-probe', description: '', parameters: {}, execute: async () => {
    body(); return [{ type: 'text', text: 'ordinary app control' }]
  } }))
  await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  if (control === 'stopping') {
    vi.mocked(recorder.readRecorderStatus).mockRejectedValueOnce(new Error('recorder observation unavailable'))
    await expect(ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)).rejects.toThrow('recorder observation unavailable')
  } else await ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)
  expect((await ctx.mydotFiling.snapshot())[0]?.filing.control).toBe(control)
  await reloadFiling(runtime)
  expect((await filingTool(ctx, 'filing-recovery-probe', agent)).isError).toBe(true)
  expect(body).not.toHaveBeenCalled()
  expect((await ctx.mydotFiling.snapshot())[0]?.confirmationReady).toBe(false)
  await expect(ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest)).rejects.toThrow(control === 'human' ? 'never resend' : 'No persisted confirmation intent')
  expect((await ctx.mydotFiling.reconcile(view.plan.caseId)).phase).toBe(control === 'human' ? 'intent' : 'approved')
  await ctx.mydotFiling.cancel(view.plan.caseId, view.revision, view.planDigest)
  stoppedFilingRecorder()
  expect(await ctx.mydotFiling.returnControl(view.plan.caseId, view.revision, view.planDigest)).toMatchObject({ phase: 'cancelled', control: 'return-authorized' })
  expect((await filingTool(ctx, 'filing-recovery-probe', agent)).isError).toBe(false)
  await reloadFiling(runtime)
  expect((await ctx.mydotFiling.snapshot())[0]).toMatchObject({ filing: { control: 'return-authorized' }, confirmationReady: false })
  expect((await filingTool(ctx, 'filing-recovery-probe', agent)).isError).toBe(false)
  expect(body).toHaveBeenCalledTimes(2)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'mydot/mock-receipt')).toHaveLength(0)
})

it('refuses startup recovery when two persisted cases claim human or stopping control', async () => {
  const runtime = await setup()
  const first = await prepared(runtime)
  const second = await anotherFiling(runtime, first)
  first.agent.session.append('mydot/filing', { view: { ...first.view, control: 'human' } })
  first.agent.session.append('mydot/filing', { view: { ...second.view, control: 'stopping' } })
  await runtime.ctx.sessions.flush(first.agent.session)
  await expect(reloadFiling(runtime)).rejects.toThrow('Multiple persisted human owners require inspection')
})

it('executes the registered reservation and preparation tools without granting model owner authority', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  await ctx.plugin(Goals)
  const disarm = vi.spyOn(ctx.goals, 'disarm')
  expect(ctx.tools.get('start_mock_filing_case')).toBeDefined()
  expect(ctx.tools.get('prepare_mock_filing')).toBeDefined()
  const missingReservationAgent = await filingTool(ctx, 'start_mock_filing_case', undefined)
  expect(missingReservationAgent.isError).toBe(true)
  expect(JSON.stringify(missingReservationAgent)).toContain('Case reservation requires the initiating Session')
  const missingPreparationAgent = await filingTool(ctx, 'prepare_mock_filing', undefined, { plan: view.plan })
  expect(missingPreparationAgent.isError).toBe(true)
  expect(JSON.stringify(missingPreparationAgent)).toContain('Filing preparation requires the initiating Session')
  const reserved = await filingTool(ctx, 'start_mock_filing_case', agent)
  expect(reserved.isError).toBe(false)
  const event = agent.session.snapshotEvents().at(-1)
  if (event?.type !== 'mydot/filing-case') throw new Error('The reservation tool must append its original-Session reservation')
  expect(event.data.caseId).toMatch(/^[a-f0-9]{32}$/)
  expect(reserved.value).toEqual({ caseId: event.data.caseId })
  expect(reserved.content).toEqual([{ type: 'text', text: JSON.stringify({ caseId: event.data.caseId }) }])
  expect(reserved.concludesTurn).toBeUndefined()
  const plan = { ...view.plan, caseId: event.data.caseId }
  const result = await filingTool(ctx, 'prepare_mock_filing', agent, { plan })
  expect(result.isError).toBe(false)
  expect(result.concludesTurn).toBe(true)
  const card = (await ctx.mydotFiling.snapshot()).find(item => item.filing.plan.caseId === plan.caseId)
  expect(card).toMatchObject({ filing: { sessionId: agent.id, plan, phase: 'prepared', actor: 'model-preparer', control: 'agent' }, confirmationReady: false })
  expect(result.value).toEqual({ caseId: plan.caseId, planDigest: card?.filing.planDigest, revision: 1 })
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
  expect(disarm).toHaveBeenCalledWith(agent)
  expect(recorder.readRecorderStatus).not.toHaveBeenCalled()
  expect(agent.session.snapshotEvents().filter(item => item.type === 'mydot/mock-receipt')).toHaveLength(0)
})

it('rejects invalid and oversized model plans through actual tool execution without appending filing decisions', async () => {
  const runtime = await setup()
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  const plans = [
    { ...view.plan, actor: 'host-owner' },
    { ...view.plan, site: 'https://real-recipient.example' },
    { ...view.plan, forms: [] },
    { ...view.plan, amount: '1.5' },
    { ...view.plan, caseId: '0'.repeat(32) },
  ]
  const before = agent.session.snapshotEvents()
  for (const plan of plans) {
    const result = await filingTool(ctx, 'prepare_mock_filing', agent, { plan })
    expect(result.isError).toBe(true)
    expect(result.concludesTurn).toBeUndefined()
    expect(agent.session.snapshotEvents()).toEqual(before)
  }
  const oversized = await filingTool(ctx, 'prepare_mock_filing', agent, { plan: { ...view.plan, legalEntity: '界'.repeat(262144) } })
  expect(oversized.isError).toBe(true)
  expect(JSON.stringify(oversized)).toContain('Filing exceeds configured byte allowance')
  expect(oversized.concludesTurn).toBeUndefined()
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect(recorder.readRecorderStatus).not.toHaveBeenCalled()
})

it('aborts queued desktop admission and drains both desktop and unrelated app tools before preparing confirmation', async () => {
  const runtime = await setup()
  await reloadFiling(runtime, { desktopTools: ['filing-race-action'] })
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  const other = await ctx.agentLoop.create(SessionId('5'.repeat(32)), {}, { cwd: runtime.root })
  const actionEntered = Promise.withResolvers<undefined>()
  const fileEntered = Promise.withResolvers<undefined>()
  const queuedEntered = Promise.withResolvers<undefined>()
  const finishAction = Promise.withResolvers<undefined>()
  const finishFile = Promise.withResolvers<undefined>()
  const actions = vi.fn()
  ctx.tools.register(defineContentToolFixture({ name: 'filing-race-action', description: '', parameters: {}, execute: async () => {
    actions(); actionEntered.resolve(undefined); await finishAction.promise; return [{ type: 'text', text: 'action finished' }]
  } }))
  ctx.tools.register(defineContentToolFixture({ name: 'filing-race-file', description: '', parameters: {}, execute: async () => {
    fileEntered.resolve(undefined); await finishFile.promise; return [{ type: 'text', text: 'file finished' }]
  } }))
  ctx.on('tools/execute', (exec, next) => {
    const dispatched = next()
    if (exec.name === 'filing-race-action' && exec.agent?.id === other.id) queuedEntered.resolve(undefined)
    return dispatched
  }, { prepend: true })
  const observation = new AbortController()
  let active: ReturnType<typeof filingTool> | undefined
  let file: ReturnType<typeof filingTool> | undefined
  let queued: ReturnType<typeof filingTool> | undefined
  let beginning: Promise<PreparedFiling['view']> | undefined
  try {
    active = filingTool(ctx, 'filing-race-action', agent)
    await actionEntered.promise
    file = filingTool(ctx, 'filing-race-file', agent)
    await fileEntered.promise
    queued = filingTool(ctx, 'filing-race-action', other)
    await queuedEntered.promise
    await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
    const stopping = filingDesktopStopping(ctx, observation.signal)
    beginning = ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)
    expect(await stopping).toMatchObject({ phase: 'stopping', owner: agent.id, inFlight: 1 })
    expect((await queued).isError).toBe(true)
    expect(actions).toHaveBeenCalledOnce()
    expect((await filingTool(ctx, 'filing-race-file', other)).isError).toBe(true)
    expect(recorder.readRecorderStatus).not.toHaveBeenCalled()
    finishAction.resolve(undefined)
    expect((await active).isError).toBe(false)
    expect((await ctx.mydot.snapshot()).desktop).toMatchObject({ phase: 'human', inFlight: 0 })
    expect((await ctx.mydotFiling.snapshot())[0]).toMatchObject({ filing: { phase: 'approved', control: 'stopping' }, confirmationReady: false })
    expect(recorder.readRecorderStatus).not.toHaveBeenCalled()
    finishFile.resolve(undefined)
    expect((await file).isError).toBe(false)
    expect(await beginning).toMatchObject({ phase: 'intent', control: 'human' })
    expect((await ctx.mydotFiling.snapshot())[0]?.confirmationReady).toBe(true)
    expect(recorder.readRecorderStatus).toHaveBeenCalledOnce()
  } finally {
    observation.abort()
    finishAction.resolve(undefined)
    finishFile.resolve(undefined)
    await Promise.allSettled([active, file, queued, beginning])
  }
})

it.each(['free', 'agent'] as const)('returns an initially %s desktop only after owner return authority and a successful fresh image capture', async (initial) => {
  const runtime = await setup()
  await reloadFiling(runtime, { desktopTools: ['filing-return-action', 'filing-return-capture'], captureTools: ['filing-return-capture'] })
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  const other = await ctx.agentLoop.create(SessionId('6'.repeat(32)), {}, { cwd: runtime.root })
  let capture: 'image' | 'text' | 'failure' = 'image'
  const actions = vi.fn()
  ctx.tools.register(defineContentToolFixture({ name: 'filing-return-action', description: '', parameters: {}, execute: async () => {
    actions(); return [{ type: 'text', text: 'operated' }]
  } }))
  ctx.tools.register(defineContentToolFixture({ name: 'filing-return-capture', description: '', parameters: {}, execute: async () => {
    if (capture === 'failure') throw new Error('capture failed')
    if (capture === 'text') return [{ type: 'text', text: 'capture produced no image' }]
    return [{ type: 'image', attachment: { attachmentId: AttachmentId('b'.repeat(32)), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }]
  } }))
  if (initial === 'agent') expect((await filingTool(ctx, 'filing-return-capture', agent)).isError).toBe(false)
  const previousCapture = (await ctx.mydot.snapshot()).desktop.capturedAt ?? 0
  await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  await ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)
  expect((await ctx.mydot.snapshot()).desktop).toMatchObject({ phase: 'human', owner: agent.id })
  expect((await filingTool(ctx, 'filing-return-capture', agent)).isError).toBe(true)
  if (initial === 'free') await ctx.mydotFiling.confirmMock(view.plan.caseId, view.revision, view.planDigest)
  else await ctx.mydotFiling.cancel(view.plan.caseId, view.revision, view.planDigest)
  stoppedFilingRecorder()
  expect(await ctx.mydotFiling.returnControl(view.plan.caseId, view.revision, view.planDigest)).toMatchObject({ control: 'return-authorized' })
  expect((await filingTool(ctx, 'filing-return-action', agent)).isError).toBe(true)
  expect((await filingTool(ctx, 'filing-return-capture', other)).isError).toBe(true)
  expect((await filingTool(ctx, 'filing-return-capture', undefined)).isError).toBe(true)
  expect(() => ctx.mydot.resumeDesktop(agent.id, previousCapture)).toThrow('A fresh desktop capture is required')
  capture = 'text'
  expect((await filingTool(ctx, 'filing-return-capture', agent)).isError).toBe(false)
  expect(() => ctx.mydot.resumeDesktop(agent.id, previousCapture)).toThrow('A fresh desktop capture is required')
  capture = 'failure'
  expect((await filingTool(ctx, 'filing-return-capture', agent)).isError).toBe(true)
  expect(() => ctx.mydot.resumeDesktop(agent.id, previousCapture)).toThrow('A fresh desktop capture is required')
  capture = 'image'
  expect((await filingTool(ctx, 'filing-return-capture', agent)).isError).toBe(false)
  const capturedAt = (await ctx.mydot.snapshot()).desktop.capturedAt!
  expect(() => ctx.mydot.resumeDesktop(agent.id, capturedAt + 1)).toThrow('A fresh desktop capture is required')
  expect(() => ctx.mydot.resumeDesktop(other.id, capturedAt)).toThrow('Desktop is owned by another job')
  expect((await filingTool(ctx, 'filing-return-action', agent)).isError).toBe(true)
  expect(ctx.mydot.resumeDesktop(agent.id, capturedAt)).toMatchObject({ phase: 'agent', owner: agent.id, capturedAt })
  expect((await filingTool(ctx, 'filing-return-action', agent)).isError).toBe(false)
  expect(actions).toHaveBeenCalledOnce()
  expect(ctx.mydot.releaseDesktop(agent.id)).toEqual({ phase: 'free', inFlight: 0 })
})

it('revokes the previous return authority when another filing takes over during its in-flight capture', async () => {
  const runtime = await setup()
  await reloadFiling(runtime, { desktopTools: ['filing-late-capture'], captureTools: ['filing-late-capture'] })
  const { ctx } = runtime
  const first = await prepared(runtime)
  const second = await anotherFiling(runtime, first)
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  const body = vi.fn()
  ctx.tools.register(defineContentToolFixture({ name: 'filing-late-capture', description: '', parameters: {}, execute: async () => {
    entered.resolve(undefined); await finish.promise
    return [{ type: 'image', attachment: { attachmentId: AttachmentId('d'.repeat(32)), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }]
  } }))
  ctx.tools.register(defineContentToolFixture({ name: 'filing-late-probe', description: '', parameters: {}, execute: async () => {
    body(); return [{ type: 'text', text: 'ordinary app control' }]
  } }))
  const { view, agent } = first
  await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  const intent = await ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)
  await ctx.mydotFiling.cancel(view.plan.caseId, view.revision, view.planDigest)
  stoppedFilingRecorder()
  await ctx.mydotFiling.returnControl(view.plan.caseId, view.revision, view.planDigest)
  vi.mocked(recorder.readRecorderStatus).mockImplementation(async (_config, caseId, planDigest) => ({
    ...intent.recorder!, caseId, planDigest, state: 'recording', readyForConfirmation: true, observedAt: Date.now(),
  }))
  const observation = new AbortController()
  let capture: ReturnType<typeof filingTool> | undefined
  let beginning: Promise<PreparedFiling['view']> | undefined
  try {
    capture = filingTool(ctx, 'filing-late-capture', agent)
    await entered.promise
    await ctx.mydotFiling.approve(second.view.plan.caseId, second.view.revision, second.view.planDigest)
    const stopping = filingDesktopStopping(ctx, observation.signal)
    beginning = ctx.mydotFiling.begin(second.view.plan.caseId, second.view.revision, second.view.planDigest, true)
    expect(await stopping).toMatchObject({ phase: 'stopping', inFlight: 1 })
    finish.resolve(undefined)
    expect((await capture).isError).toBe(false)
    expect(await beginning).toMatchObject({ phase: 'intent', control: 'human' })
    const capturedAt = (await ctx.mydot.snapshot()).desktop.capturedAt!
    expect(() => ctx.mydot.resumeDesktop(agent.id, capturedAt)).toThrow('Filing takeover requires explicit return authority')
    expect((await filingTool(ctx, 'filing-late-probe', agent)).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
    expect((await ctx.mydot.snapshot()).desktop.phase).toBe('human')
  } finally {
    observation.abort(); finish.resolve(undefined)
    await Promise.allSettled([capture, beginning])
  }
})

it('keeps app control fenced when desktop return has no configured capture and restores return authority after reconfiguration', async () => {
  const runtime = await setup()
  await reloadFiling(runtime, { desktopTools: ['filing-reconfigured-action'] })
  const { ctx } = runtime
  const { agent, view } = await prepared(runtime)
  ctx.tools.register(defineContentToolFixture({ name: 'filing-reconfigured-action', description: '', parameters: {}, execute: async () => [{ type: 'text', text: 'operated' }] }))
  ctx.tools.register(defineContentToolFixture({ name: 'filing-reconfigured-capture', description: '', parameters: {}, execute: async () => [
    { type: 'image', attachment: { attachmentId: AttachmentId('c'.repeat(32)), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
  ] }))
  await ctx.mydotFiling.approve(view.plan.caseId, view.revision, view.planDigest)
  await ctx.mydotFiling.begin(view.plan.caseId, view.revision, view.planDigest, true)
  await ctx.mydotFiling.cancel(view.plan.caseId, view.revision, view.planDigest)
  stoppedFilingRecorder()
  await expect(ctx.mydotFiling.returnControl(view.plan.caseId, view.revision, view.planDigest)).rejects.toThrow('Configure a fresh capture before returning desktop control')
  expect((await ctx.mydotFiling.snapshot())[0]?.filing.control).toBe('return-authorized')
  expect((await filingTool(ctx, 'filing-reconfigured-action', agent)).isError).toBe(true)
  await reloadFiling(runtime, { desktopTools: ['filing-reconfigured-action', 'filing-reconfigured-capture'], captureTools: ['filing-reconfigured-capture'] })
  expect((await ctx.mydot.snapshot()).desktop).toMatchObject({ phase: 'human', owner: agent.id })
  expect((await filingTool(ctx, 'filing-reconfigured-action', agent)).isError).toBe(true)
  expect((await filingTool(ctx, 'filing-reconfigured-capture', agent)).isError).toBe(false)
  const capturedAt = (await ctx.mydot.snapshot()).desktop.capturedAt!
  expect(ctx.mydot.resumeDesktop(agent.id, capturedAt)).toMatchObject({ phase: 'agent', owner: agent.id })
  expect((await filingTool(ctx, 'filing-reconfigured-action', agent)).isError).toBe(false)
})

it('cancels queued desktop admission on plugin disposal and removes filing tools and execution listeners', async () => {
  const runtime = await setup()
  await reloadFiling(runtime, { desktopTools: ['filing-dispose-action'] })
  const { ctx } = runtime
  const { agent } = await prepared(runtime)
  const other = await ctx.agentLoop.create(SessionId('7'.repeat(32)), {}, { cwd: runtime.root })
  const entered = Promise.withResolvers<undefined>()
  const queuedEntered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  const bodies = vi.fn()
  ctx.tools.register(defineContentToolFixture({ name: 'filing-dispose-action', description: '', parameters: {}, execute: async () => {
    bodies(); entered.resolve(undefined); await finish.promise; return [{ type: 'text', text: 'finished' }]
  } }))
  ctx.on('tools/execute', (exec, next) => {
    const dispatched = next()
    if (exec.name === 'filing-dispose-action' && exec.agent?.id === other.id) queuedEntered.resolve(undefined)
    return dispatched
  }, { prepend: true })
  let active: ReturnType<typeof filingTool> | undefined
  let queued: ReturnType<typeof filingTool> | undefined
  let disposal: Promise<unknown> | undefined
  try {
    active = filingTool(ctx, 'filing-dispose-action', agent)
    await entered.promise
    queued = filingTool(ctx, 'filing-dispose-action', other)
    await queuedEntered.promise
    disposal = Promise.resolve(filingEntry(ctx).update({ disabled: true }))
    expect((await queued).isError).toBe(true)
    expect(bodies).toHaveBeenCalledOnce()
    finish.resolve(undefined)
    expect((await active).isError).toBe(false)
    await disposal
    expect(ctx.get('mydot')).toBeUndefined()
    expect(ctx.get('mydotFiling')).toBeUndefined()
    expect(ctx.tools.get('start_mock_filing_case')).toBeUndefined()
    expect(ctx.tools.get('prepare_mock_filing')).toBeUndefined()
    expect((await filingTool(ctx, 'start_mock_filing_case', agent)).isError).toBe(true)
    expect((await filingTool(ctx, 'prepare_mock_filing', agent, { plan: {} })).isError).toBe(true)
    expect((await filingTool(ctx, 'filing-dispose-action', other)).isError).toBe(false)
    expect(bodies).toHaveBeenCalledTimes(2)
  } finally {
    finish.resolve(undefined)
    await Promise.allSettled([active, queued, disposal])
  }
})
