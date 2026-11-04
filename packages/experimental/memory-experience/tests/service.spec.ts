import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { GoalId } from '@deepseek-ai/dsh-goal'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Commands from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { TestSessionQueryEngine } from '../../../session-query/session-query/tests/test-service.ts'
import ExperienceMemory from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup(
  config: Partial<ConstructorParameters<typeof ExperienceMemory>[1]> = {}, pool = new MemoryMediaPool(),
  configure?: (ctx: Context) => void,
) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Commands)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  ctx.provide('storageDomain', facility)
  await ctx.plugin(TestSessionQueryEngine)
  const loop = await mountAgentLoopTestHarness(ctx)
  configure?.(ctx)
  const fiber = await ctx.plugin(ExperienceMemory, config)
  const agent = await loop.create(SessionId('present'), {}, { cwd: process.cwd() })
  await ctx.experienceMemory.flush()
  return { ctx, agent, fiber, pool, loop }
}

function turn(agent: Agent, number: number, request = 'repair dependency build failure') {
  loggedTurn(agent.session, number, request)
}

function loggedTurn(session: Session, number: number, request = 'repair dependency build failure', beforeEnd?: (session: Session) => void) {
  session.append('turn/start', { turn: number })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: request }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('tool/call', { turn: number, step: 1, callId: ToolCallId(`tool-${number}`), name: 'bash', arguments: '{"command":"pnpm build"}' })
  session.append('tool/result', { turn: number, step: 1, message: createToolResultMessage({ callId: ToolCallId(`tool-${number}`), content: [{ type: 'text', text: 'actual verification output' }], isError: false }) }, { surfaceOp: 'append' })
  beforeEnd?.(session)
  session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
}

function record(id: string, header: Partial<SessionHeader> = {}, beforeEnd?: (session: Session) => void): SessionLogSnapshot {
  const metadata: SessionHeader = {
    id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false, cwd: process.cwd(), ...header,
  }
  const session = Session.create(metadata.id, [], metadata)
  loggedTurn(session, 1, 'repair dependency build failure', beforeEnd)
  return { session: metadata, inheritedEventCount: SessionLogOffset(0), events: [...session.snapshotEvents()] }
}

function persistedQueries(ctx: Context, records: SessionLogSnapshot[]) {
  const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  vi.spyOn(ctx.sessionQuery, 'readSession').mockImplementation((id) => {
    const stored = records.find(value => value.session.id === id)
    return stored === undefined ? read(id) : Promise.resolve(structuredClone(stored))
  })
  vi.spyOn(ctx.sessionQuery, 'filterSessions').mockResolvedValue(records.map(value => ({ header: value.session, live: false, persisted: true })))
}

async function enter(ctx: Context, agent: Agent, number: number, text: string) {
  const messages = [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })]
  return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: number, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages, startsRequestSeries: true }))
}

async function prompt(ctx: Context, agent: Agent): Promise<string> {
  return (await ctx.systemPrompt.assemble({ agent, scope: agent })).contexts.find(value => value.name === 'memory-experience')?.text ?? ''
}

describe('experience memory service', () => {
  it('rejects unsafe numeric configuration before registering consumers', () => {
    const invalid = [
      { maxTokens: Number.MAX_SAFE_INTEGER + 1 }, { contextOrder: Number.POSITIVE_INFINITY }, { maxTokens: -1 }, { maxEpisodes: 0.5 },
    ]
    for (const config of invalid) {
      const ctx = new Context()
      contexts.push(ctx)
      expect(() => new ExperienceMemory(ctx, config)).toThrow()
    }
    const ctx = new Context()
    contexts.push(ctx)
    const service = new ExperienceMemory(ctx)
    expect(() => service.status()).toThrow('domain is not initialized')
  })

  it('fails initialization on incompatible stored records instead of treating them as empty memory', async () => {
    const pool = new MemoryMediaPool()
    pool.media.set('memory_experience', { tables: new Map([['episodes', new Map([['broken', { state: 'active' }]])]]), global: null })
    await expect(setup({}, pool)).rejects.toThrow()
  })

  it('requires source durability and reports absent flush participation without saving', async () => {
    const { ctx, agent } = await setup()
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    expect(await ctx.experienceMemory.list(agent)).toEqual([])
    expect(ctx.experienceMemory.status().lastError).toContain('durability listener')
    ctx.on('session/flush', () => {})
    await enter(ctx, agent, 2, 'build failure')
    expect((await ctx.experienceMemory.list(agent))[0]).toMatchObject({ outcome: 'unknown', endSeq: 4 })
  })

  it('flushes before saving and preserves the complete waterfall decision', async () => {
    const { ctx, agent } = await setup()
    let release: (() => void) | undefined
    const stop = ctx.on('session/flush', () => new Promise<void>((resolve) => { release = resolve }))
    turn(agent, 1)
    const settled = ctx.experienceMemory.flush()
    await vi.waitFor(() =>{  expect(release).toBeTypeOf('function') })
    expect(ctx.storageDomain.get('memory_experience')?.table('episodes').size).toBe(0)
    release?.()
    await settled
    stop()
    ctx.on('session/flush', () => {})
    expect((await ctx.experienceMemory.list(agent))).toHaveLength(1)
  })

  it('freezes selection for a work group, clears on a new zero-match request, and retires immediately', async () => {
    const { ctx, agent } = await setup()
    ctx.on('session/flush', () => {})
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    const decision = await enter(ctx, agent, 2, 'build failure')
    expect(decision).toMatchObject({ kind: 'enter', startsRequestSeries: true })
    const first = await prompt(ctx, agent)
    expect(first).toContain('present#3')
    await enter(ctx, agent, 2, 'unrelated mineralogy')
    expect(await prompt(ctx, agent)).toBe(first)
    const record = (await ctx.experienceMemory.list(agent))[0]
    if (record === undefined) throw new Error('Expected stored experience')
    expect(await ctx.experienceMemory.retire(agent, record.id)).toBe(true)
    expect(await prompt(ctx, agent)).toBe('')
    await enter(ctx, agent, 3, 'unrelated mineralogy')
    expect(await prompt(ctx, agent)).toBe('')
    await ctx.sessions.flush(agent.session)
    expect((await ctx.experienceMemory.inspect(agent, record.id))?.state).toBe('retired')
  })

  it('keeps storage write failures visible and removes all registrations on disposal', async () => {
    const { ctx, agent, fiber, pool } = await setup()
    ctx.on('session/flush', () => {})
    pool.failNextWrites = 1
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    expect(ctx.experienceMemory.status().lastError).toContain('injected write failure')
    expect(await ctx.experienceMemory.list(agent)).toEqual([])
    await fiber.dispose()
    expect(ctx.get('experienceMemory')).toBeUndefined()
    expect(await prompt(ctx, agent)).toBe('')
    expect(ctx.commands.list(agent).some(value => value.name === 'memory-experience')).toBe(false)
  })

  it('off mode avoids automatic reads and capture while keeping status commands available', async () => {
    const { ctx, agent } = await setup({ mode: 'off' })
    const reads = vi.spyOn(ctx.sessionQuery, 'filterSessions')
    turn(agent, 1)
    await enter(ctx, agent, 2, 'build failure')
    await ctx.experienceMemory.flush()
    expect(reads).not.toHaveBeenCalled()
    expect(await ctx.experienceMemory.list(agent)).toEqual([])
    expect(await prompt(ctx, agent)).toBe('')
    const command = await ctx.commands.execute(agent, '/memory-experience status', [], new AbortController().signal)
    if (command === undefined) throw new Error('memory command was not registered')
    expect(command.result).toMatchObject({ kind: 'success' })
    expect(command.result.text).toContain('off')
  })

  it('clears rejected work and an admitted non-task message without reviving the prior selection', async () => {
    const { ctx, agent } = await setup()
    ctx.on('session/flush', () => {})
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    await enter(ctx, agent, 2, 'build failure')
    expect(await prompt(ctx, agent)).not.toBe('')
    const stop = ctx.on('agent/pre-step', async () => ({ kind: 'reject' as const }))
    expect(await enter(ctx, agent, 3, 'build failure')).toEqual({ kind: 'reject' })
    expect(await prompt(ctx, agent)).toBe('')
    stop()
    await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 4, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    expect(await prompt(ctx, agent)).toBe('')
  })

  it('honors cancellation while waiting for its owned queue and rejects mutations after disposal', async () => {
    const { ctx, agent, fiber } = await setup()
    let release: (() => void) | undefined
    const stop = ctx.on('session/flush', () => new Promise<void>((resolve) => { release = resolve }))
    turn(agent, 1)
    await vi.waitFor(() =>{  expect(release).toBeTypeOf('function') })
    const abort = new AbortController()
    const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'build failure' }] })]
    const entered = agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 2, step: 1, signal: abort.signal }, () => Promise.resolve({ kind: 'enter' as const, messages }))
    abort.abort('cancelled work')
    stop()
    release?.()
    expect(await entered).toMatchObject({ kind: 'enter' })
    expect(await prompt(ctx, agent)).toBe('')
    await ctx.experienceMemory.flush()
    const service = ctx.experienceMemory
    await fiber.dispose()
    await expect(service.retire(agent, 'present:turn:1')).rejects.toThrow('service is disposing')
  })

  it('shows failed human retirement without restoring affected current recall', async () => {
    const { ctx, agent, pool } = await setup()
    ctx.on('session/flush', () => {})
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    await enter(ctx, agent, 2, 'build failure')
    const id = (await ctx.experienceMemory.list(agent))[0]!.id
    pool.failNextWrites = 1
    const command = await ctx.commands.execute(agent, `/memory-experience retire ${id}`, [], new AbortController().signal)
    expect(command?.result.kind).toBe('error')
    expect(command?.result.text).toContain('injected write failure')
    expect(await prompt(ctx, agent)).toBe('')
    await expect(ctx.experienceMemory.inspect(agent, '')).rejects.toThrow()
  })

  it('reconciles live Sessions already present when the plugin mounts and ignores unpersisted catalog entries', async () => {
    const { ctx, agent } = await setup({}, new MemoryMediaPool(), (subject) => {
      subject.on('session/flush', () => {})
      const live = subject.sessions.create(SessionId('initial-live'), { meta: { cwd: process.cwd() } })
      loggedTurn(live, 1)
      subject.sessions.create(SessionId('initial-unscoped'))
      vi.spyOn(subject.sessionQuery, 'filterSessions').mockResolvedValue([{ header: live.header, live: true, persisted: false }, { header: record('unpersisted').session, live: false, persisted: false }])
    })
    expect((await ctx.experienceMemory.list(agent)).map(value => value.sessionId)).toEqual(['initial-live'])
    expect((await ctx.systemPrompt.assemble({ scope: ctx })).contexts.find(value => value.name === 'memory-experience')?.text).toBe('')
  })

  it('caps capture at the source range frozen before flush starts', async () => {
    const { ctx, agent } = await setup()
    let release: (() => void) | undefined
    const stop = ctx.on('session/flush', () => new Promise<void>((resolve) => { release = resolve }))
    turn(agent, 1)
    const pending = ctx.experienceMemory.flush()
    await vi.waitFor(() =>{  expect(release).toBeTypeOf('function') })
    turn(agent, 2, 'later task not included in the held checkpoint')
    stop()
    release?.()
    await pending
    await ctx.experienceMemory.flush()
    expect((await ctx.experienceMemory.list(agent)).map(value => value.turn)).toEqual([1])
  })

  it('searches a short continuation with its actual prior admitted request', async () => {
    const { ctx, agent } = await setup()
    ctx.on('session/flush', () => {})
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    await enter(ctx, agent, 2, 'continue')
    expect(await prompt(ctx, agent)).toContain('actual verification output')
  })

  it('restores fixed selections after a restart and preserves retirement tombstones during recapture', async () => {
    const first = await setup()
    first.ctx.on('session/flush', () => {})
    turn(first.agent, 1)
    await first.ctx.experienceMemory.flush()
    await enter(first.ctx, first.agent, 2, 'build failure')
    const original = await prompt(first.ctx, first.agent)
    await first.ctx.fiber.dispose()
    const second = await setup({}, first.pool)
    second.ctx.on('session/flush', () => {})
    await enter(second.ctx, second.agent, 2, 'unrelated topic')
    expect(await prompt(second.ctx, second.agent)).toBe(original)
    const episode = (await second.ctx.experienceMemory.list(second.agent))[0]!
    expect(await second.ctx.experienceMemory.retire(second.agent, episode.id)).toBe(true)
    expect(await second.ctx.experienceMemory.retire(second.agent, episode.id)).toBe(true)
    turn(second.agent, 1)
    await second.ctx.experienceMemory.flush()
    expect(await second.ctx.experienceMemory.inspect(second.agent, episode.id)).toMatchObject({ state: 'retired' })
    expect(await prompt(second.ctx, second.agent)).toBe('')
    expect((await second.ctx.experienceMemory.list(second.agent))).toHaveLength(1)
  })

  it('clears old recall on a query failure and resumes normal work without stale text', async () => {
    const { ctx, agent } = await setup()
    ctx.on('session/flush', () => {})
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    await enter(ctx, agent, 2, 'build failure')
    expect(await prompt(ctx, agent)).not.toBe('')
    const failure = vi.spyOn(ctx.sessionQuery, 'readSession').mockRejectedValue(new Error('query unavailable'))
    expect(await enter(ctx, agent, 3, 'build failure')).toMatchObject({ kind: 'enter' })
    expect(await prompt(ctx, agent)).toBe('')
    expect(ctx.experienceMemory.status().lastError).toContain('query unavailable')
    failure.mockRestore()
    await enter(ctx, agent, 3, 'build failure')
    expect(await prompt(ctx, agent)).not.toBe('')
  })

  it('keeps other directory scopes private for lookup, inspection, retirement and rendering', async () => {
    const { ctx, agent, loop } = await setup()
    ctx.on('session/flush', () => {})
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    const id = (await ctx.experienceMemory.list(agent))[0]!.id
    const other = await loop.create(SessionId('other-project'), {}, { cwd: '/other-project' })
    await ctx.experienceMemory.flush()
    await enter(ctx, other, 1, 'build failure')
    expect(await prompt(ctx, other)).toBe('')
    expect(await ctx.experienceMemory.list(other)).toEqual([])
    expect(await ctx.experienceMemory.inspect(other, id)).toBeUndefined()
    expect(await ctx.experienceMemory.retire(other, id)).toBe(false)
    expect(await ctx.experienceMemory.retire(agent, 'missing-id')).toBe(false)
    const unscoped = await loop.create(SessionId('unknown-project'), {})
    turn(unscoped, 1)
    await ctx.experienceMemory.flush()
    await enter(ctx, unscoped, 1, 'build failure')
    expect(await ctx.experienceMemory.list(unscoped)).toEqual([])
    expect(await ctx.experienceMemory.retire(unscoped, id)).toBe(false)
    expect(await prompt(ctx, unscoped)).toBe('')
  })

  it('reports candidate exhaustion and does not admit memory when its token budget is zero', async () => {
    const { ctx, agent } = await setup({ maxCandidates: 1, maxTokens: 0 })
    ctx.on('session/flush', () => {})
    turn(agent, 1)
    turn(agent, 2)
    await ctx.experienceMemory.flush()
    expect(await ctx.experienceMemory.list(agent)).toHaveLength(1)
    expect(ctx.experienceMemory.status().candidatesExhausted).toBe(true)
    expect(ctx.experienceMemory.status().lastError).toContain('candidate limit 1')
    await enter(ctx, agent, 3, 'build failure')
    expect(await prompt(ctx, agent)).toBe('')
  })

  it('supports inspection commands and returns actionable errors without a model call', async () => {
    const { ctx, agent } = await setup()
    ctx.on('session/flush', () => {})
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    const id = (await ctx.experienceMemory.list(agent))[0]!.id
    const execute = async (input: string, signal = new AbortController().signal) => {
      const command = await ctx.commands.execute(agent, `/memory-experience${input}`, [], signal)
      if (command === undefined) throw new Error('memory command was not registered')
      return command.result
    }
    for (const input of ['', ' status', ' list', ` inspect ${id}`, ` retire ${id}`]) expect(await execute(input)).toMatchObject({ kind: 'success' })
    for (const input of [' inspect', ' unknown id', ' inspect missing', ' retire missing', ' inspect one two']) expect(await execute(input)).toMatchObject({ kind: 'error' })
    const abort = new AbortController()
    abort.abort(new Error('cancelled inspection'))
    await expect(execute(' status', abort.signal)).rejects.toThrow('cancelled inspection')
  })

  it('transfers a frozen work selection to a newly created goal and reuses it for later rounds', async () => {
    const { ctx, agent } = await setup()
    ctx.on('session/flush', () => {})
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    await enter(ctx, agent, 2, 'build failure')
    const selected = await prompt(ctx, agent)
    agent.session.append('turn/start', { turn: 2 })
    const goal = { id: GoalId('ongoing'), revision: 1, objective: 'repair dependency build failure', phase: 'active' as const, maxGoalRounds: 10 }
    const change = { kind: 'goal/change' as const, version: 1 as const, operation: 'create' as const, goal, roundsStarted: 0, createdAt: 1, updatedAt: 1 }
    agent.session.append('goal/change', change)
    await ctx.experienceMemory.flush()
    expect(await prompt(ctx, agent)).toBe(selected)
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'goal', goalId: goal.id, revision: 1, round: 2 } })]
    await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 3, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter' as const, messages }))
    expect(await prompt(ctx, agent)).toBe(selected)
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    agent.session.append('turn/start', { turn: 3 })
    agent.session.append('user/message', messages[0]!, { surfaceOp: 'append' })
    agent.session.append('goal/change', { ...change, operation: 'edit', goal: { ...goal, revision: 2 } })
    await ctx.experienceMemory.flush()
    expect(ctx.experienceMemory.status().selections).toBe(2)
  })

  it('recovers durable ended intervals after a missed notification and reports a bounded recovery', async () => {
    const records = [record('stored-one'), record('stored-two')]
    const { ctx, agent } = await setup({ maxRecoverSessions: 1 }, new MemoryMediaPool(), (subject) => {
      persistedQueries(subject, records)
    })
    expect((await ctx.experienceMemory.list(agent)).map(value => value.sessionId)).toEqual(['stored-one'])
    expect(ctx.experienceMemory.status().recoveryExhausted).toBe(true)
    expect(ctx.experienceMemory.status().lastError).toContain('recovery limit 1')
    ctx.on('session/flush', () => {})
    await enter(ctx, agent, 1, 'build failure')
    expect(await prompt(ctx, agent)).toContain('stored-one')
    expect(await prompt(ctx, agent)).not.toContain('stored-two')
  })

  it('keeps the selected memory through tool steps when a new human request belongs to an existing goal', async () => {
    const { ctx, agent } = await setup()
    ctx.on('session/flush', () => {})
    turn(agent, 1)
    await ctx.experienceMemory.flush()
    const goal = { id: GoalId('existing-goal'), revision: 1, objective: 'repair dependency build failure', phase: 'active' as const, maxGoalRounds: 10 }
    agent.session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal, roundsStarted: 0, createdAt: 1, updatedAt: 1 })
    await ctx.experienceMemory.flush()
    await enter(ctx, agent, 2, 'build failure')
    const selected = await prompt(ctx, agent)
    expect(selected).not.toBe('')
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'build failure' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 2, step: 2, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    expect(await prompt(ctx, agent)).toBe(selected)
  })

  it('leaves fresh goal-only and cleared-goal continuations empty when no experience matches', async () => {
    const { ctx, loop } = await setup()
    ctx.on('session/flush', () => {})
    for (const state of ['none', 'active', 'clear'] as const) {
      const agent = await loop.create(SessionId(`goal-only-${state}`), {}, { cwd: process.cwd() })
      if (state !== 'none') {
        const goal = { id: GoalId(`goal-${state}`), revision: 1, objective: 'unique mineralogy objective', phase: 'active' as const, maxGoalRounds: 10 }
        agent.session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal, roundsStarted: 0, createdAt: 1, updatedAt: 1 })
        if (state === 'clear') agent.session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: goal.id, revision: 1 }, clearedAt: 2 })
      }
      await ctx.experienceMemory.flush()
      await enter(ctx, agent, 1, 'continue')
      expect(await prompt(ctx, agent)).toBe('')
    }
  })

  it('drops recall if the parent attribution disappears between capture and selection', async () => {
    const { ctx } = await setup()
    ctx.on('session/flush', () => {})
    const parent = record('changing-parent', {}, session => session.append('subagent/catalog', { version: 0, childId: SessionId('changing-child'), childCreatedAt: 0, mode: 'one-shot' }))
    const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
    let childReads = 0
    let selecting = false
    vi.spyOn(ctx.sessionQuery, 'readSession').mockImplementation((id) => {
      if (id === SessionId('changing-child') && selecting) childReads += 1
      if (id !== parent.session.id) return read(id)
      return Promise.resolve(childReads < 2 ? parent : { ...parent, events: [] })
    })
    const { agent: child } = await ctx.agents.create({ sessionId: SessionId('changing-child'), meta: { cwd: process.cwd(), origin: 'subagent', parentSession: parent.session.id } })
    await ctx.experienceMemory.flush()
    selecting = true
    expect(await enter(ctx, child, 1, 'build failure')).toMatchObject({ kind: 'enter' })
    expect(await prompt(ctx, child)).toBe('')
    expect(ctx.experienceMemory.status().lastError).toContain('cannot resolve root task')
  })

  it('reuses a durable goal selection when a resumed turn adopts that goal', async () => {
    const first = await setup()
    first.ctx.on('session/flush', () => {})
    turn(first.agent, 1)
    await first.ctx.experienceMemory.flush()
    await enter(first.ctx, first.agent, 2, 'build failure')
    first.agent.session.append('turn/start', { turn: 2 })
    const goal = { id: GoalId('durable-goal'), revision: 1, objective: 'repair build', phase: 'active' as const, maxGoalRounds: 10 }
    const change = { kind: 'goal/change' as const, version: 1 as const, operation: 'create' as const, goal, roundsStarted: 0, createdAt: 1, updatedAt: 1 }
    first.agent.session.append('goal/change', change)
    await first.ctx.experienceMemory.flush()
    const selected = await prompt(first.ctx, first.agent)
    await first.ctx.fiber.dispose()
    const second = await setup({}, first.pool)
    second.ctx.on('session/flush', () => {})
    await enter(second.ctx, second.agent, 2, 'build failure')
    second.agent.session.append('turn/start', { turn: 2 })
    second.agent.session.append('goal/change', change)
    await second.ctx.experienceMemory.flush()
    expect(await prompt(second.ctx, second.agent)).toBe(selected)
    expect(second.ctx.experienceMemory.status().selections).toBe(2)
  })

  it('groups parent and nested child evidence as one prior work item', async () => {
    const parent = record('root-work', {}, session => session.append('subagent/catalog', { version: 0, childId: SessionId('child-work'), childCreatedAt: 0, mode: 'one-shot' }))
    const child = record('child-work', { origin: 'subagent', parentSession: parent.session.id }, session => session.append('subagent/catalog', { version: 0, childId: SessionId('grandchild-work'), childCreatedAt: 0, mode: 'one-shot' }))
    const grandchild = record('grandchild-work', { origin: 'subagent', parentSession: child.session.id })
    const { ctx, agent } = await setup({}, new MemoryMediaPool(), (subject) => { persistedQueries(subject, [parent, child, grandchild]) })
    const episodes = await ctx.experienceMemory.list(agent)
    expect(episodes).toHaveLength(3)
    expect(new Set(episodes.map(value => value.groupId))).toEqual(new Set(['root-work:turn:1']))
    ctx.on('session/flush', () => {})
    await enter(ctx, agent, 1, 'build failure')
    expect((await prompt(ctx, agent)).match(/Episode:/gu)).toHaveLength(1)
  })

  it.each(['missing-parent', 'missing-catalog', 'foreign-project', 'cycle', 'depth-limit'] as const)('refuses unverified subagent attribution: %s', async (failure) => {
    const child = record('child', failure === 'missing-parent' ? { origin: 'subagent' } : { origin: 'subagent', parentSession: SessionId('parent') })
    const parent = record('parent', failure === 'foreign-project' ? { cwd: '/foreign' } : failure === 'cycle' ? { origin: 'subagent', parentSession: SessionId('parent') } : {},
      failure === 'missing-catalog' ? undefined : (session) => {
        session.append('subagent/catalog', { version: 0, childId: child.session.id, childCreatedAt: 0, mode: 'one-shot' })
        if (failure === 'cycle') session.append('subagent/catalog', { version: 0, childId: session.id, childCreatedAt: 0, mode: 'one-shot' })
      })
    if (failure === 'depth-limit') parent.session = { ...parent.session, origin: 'subagent', parentSession: SessionId('grandparent') }
    const { ctx, agent } = await setup({ maxRecoverSessions: failure === 'depth-limit' ? 1 : 100 }, new MemoryMediaPool(), (subject) => { persistedQueries(subject, [child, parent]) })
    expect(await ctx.experienceMemory.list(agent)).toEqual([])
    expect(ctx.experienceMemory.status().lastError).toContain('cannot attribute child')
  })
})
