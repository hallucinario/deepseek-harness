/** Evidence admission, external failures and lifecycle against real Session persistence. */
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { TestSessionQuery } from '../../../subagent/subagent/tests/test-session-query.ts'
import { MyDotEvidence } from '../src/verification.ts'
import type { EvidenceConfig } from '../src/verification.ts'
import { check, commit, job, run } from './verification-fixture.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function handle(text: string | undefined, exitCode = 0, lossy = false,
  done: Promise<SubprocessOutcome> = Promise.resolve({ exitCode, signal: null })): SubprocessHandle {
  return {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: text === undefined ? {} : { stdout: { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy }) } },
    done, terminate: () => undefined, waitForExit: async () => true,
  }
}

function response(spec: SubprocessSpawnSpec): unknown {
  const endpoint = spec.argv[6]!
  return endpoint.includes('/contents/') ? { type: 'file', sha: check.workflowFileSha }
    : endpoint.includes('/jobs?') ? { jobs: [job] } : run
}

class GitHubFixture extends SubprocessRuntime {
  override resolveExecutable = vi.fn(async (_command: string, _env?: Readonly<Record<string, string>>, _signal?: AbortSignal) => '/fixture/gh')
  override spawn = vi.fn((spec: SubprocessSpawnSpec) => handle(JSON.stringify(response(spec))))
  override terminalEnvironment(): Promise<never> { return Promise.reject(new Error('No terminal in this evidence scenario')) }
  override spawnTerminal(): Promise<never> { return Promise.reject(new Error('No terminal in this evidence scenario')) }
}

async function setup(overrides: Partial<EvidenceConfig> = {}, persistence = true) {
  const ctx = new Context()
  contexts.push(ctx)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-evidence-service-')))
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  if (persistence) await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(GitHubFixture)
  const config: EvidenceConfig = { checks: [check], timeoutMs: 30000, maxOutputBytes: 1024 * 1024, changed: vi.fn(), ...overrides }
  const fiber = await ctx.plugin(MyDotEvidence, config)
  const owner = await ctx.agents.create({ sessionId: SessionId('evidence-service'), meta: { cwd: root } })
  const agent = owner.agent
  const request = agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the parser' }] }), { surfaceOp: 'append' })
  const input = { requestSeq: request.seq, checkId: check.id, commit }
  const transport = ctx.subprocess as GitHubFixture
  const view = async () => {
    using source = await ctx.sessionQuery.observeSession(agent.id)
    return await ctx.mydotEvidence.view(source)
  }
  return { ctx, agent, owner, input, transport, config, fiber, view }
}

it.each([
  ['duplicate condition identities', { checks: [check, check] }, 'identities must be unique'],
  ['zero deadline', { timeoutMs: 0 }, 'Invalid verification transport bounds'],
  ['deadline outside the timer range', { timeoutMs: 2_147_483_648 }, 'Invalid verification transport bounds'],
  ['fractional output limit', { maxOutputBytes: 1.5 }, 'Invalid verification transport bounds'],
  ['empty output limit', { maxOutputBytes: 0 }, 'Invalid verification transport bounds'],
] satisfies [string, Partial<EvidenceConfig>, string][])('rejects %s in deployment configuration', async (_name, overrides, message) => {
  await expect(setup(overrides)).rejects.toThrow(message)
})

it('attributes both Remote operations to the selected Session resource', async () => {
  const { ctx, agent, transport } = await setup()
  const methods = remoteMethods(ctx.mydotEvidence)
  expect(methods.map(method => method.method).sort()).toEqual(['refresh', 'setTarget'])
  for (const method of methods) expect(method.resources?.session?.(agent.id)).toBe(agent.id)
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('rejects unknown requests, disabled conditions, malformed commits and run IDs before external reads', async () => {
  const { ctx, agent, input, transport, view } = await setup()
  const service = ctx.mydotEvidence
  expect(await view()).toMatchObject({ target: null, history: [], status: 'unobserved' })
  await expect(service.setTarget(SessionId('unknown-session'), input)).rejects.toMatchObject({ code: 'session-unavailable' })
  for (const invalid of [{ ...input, requestSeq: SessionSeq(999) }, { ...input, commit: 'abbreviated' }]) {
    await expect(service.setTarget(agent.id, invalid)).rejects.toMatchObject({ code: 'invalid-target' })
  }
  const other = await setup({ checks: [] })
  await expect(other.ctx.mydotEvidence.setTarget(other.agent.id, other.input)).rejects.toMatchObject({ code: 'invalid-target' })
  const target = await service.setTarget(agent.id, input)
  for (const runId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(service.refresh(agent.id, target.seq, runId, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-target' })
  }
  await service.setTarget(agent.id, { ...input, commit: 'b'.repeat(40) })
  await expect(service.refresh(agent.id, target.seq, run.id, new AbortController().signal)).rejects.toMatchObject({ code: 'stale-target' })
  expect(transport.resolveExecutable).not.toHaveBeenCalled()
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('rejects a snapshot taken while its evidence projection was disabled', async () => {
  const { ctx, agent, config, fiber } = await setup()
  await fiber.dispose()
  using unavailable = await ctx.sessionQuery.observeSession(agent.id)
  await ctx.plugin(MyDotEvidence, config)
  await expect(ctx.mydotEvidence.view(unavailable)).rejects.toMatchObject({ code: 'session-unavailable' })
})

it('rejects refresh when the selected request is replaced in the actual Session surface', async () => {
  const { ctx, agent, input, transport, view } = await setup()
  const target = await ctx.mydotEvidence.setTarget(agent.id, input)
  agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'New request' }] }), {
    surfaceOp: { op: 'replace', startSeq: input.requestSeq, endSeq: input.requestSeq }, sourceEventSeqs: [input.requestSeq],
  })
  await expect(ctx.mydotEvidence.refresh(agent.id, target.seq, run.id, new AbortController().signal)).rejects.toMatchObject({ code: 'stale-target' })
  expect(await view()).toMatchObject({ definitionCurrent: false, status: 'unobserved' })
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('shares the durability checkpoint when the same target is submitted concurrently', async () => {
  const { ctx, agent, input } = await setup()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const checkpoint = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    entered.resolve(undefined); await release.promise; return flush(session)
  })
  const first = ctx.mydotEvidence.setTarget(agent.id, input)
  await entered.promise
  const second = ctx.mydotEvidence.setTarget(agent.id, input)
  expect(checkpoint).toHaveBeenCalledTimes(1)
  release.resolve(undefined)
  expect(await second).toEqual(await first)
  expect(checkpoint).toHaveBeenCalledTimes(1)
})

it.each([
  ['authentication failure', () => handle(JSON.stringify(run), 4), 'provider-unavailable'],
  ['missing output', () => handle(undefined), 'provider-unavailable'],
  ['truncated output', () => handle(JSON.stringify(run), 0, true), 'provider-unavailable'],
  ['malformed JSON', () => handle('{'), 'invalid-response'],
  ['invalid API response', () => handle('{}'), 'invalid-response'],
] as const)('records %s as uncertainty after an earlier success', async (_name, failedHandle, reason) => {
  const { ctx, agent, input, transport, view } = await setup()
  const target = await ctx.mydotEvidence.setTarget(agent.id, input)
  await ctx.mydotEvidence.refresh(agent.id, target.seq, run.id, new AbortController().signal)
  expect((await view()).status).toBe('passed')
  transport.spawn.mockImplementationOnce(failedHandle)
  await ctx.mydotEvidence.refresh(agent.id, target.seq, run.id, new AbortController().signal)
  expect(await view()).toMatchObject({ status: 'unavailable', history: [
    { observation: { outcome: 'passed' } }, { observation: { outcome: 'unavailable', reason } },
  ] })
})

it.each(['lookup', 'spawn', 'completion'] as const)('retains a %s provider failure without accepting a supplied verdict', async (phase) => {
  const { ctx, agent, input, transport, view } = await setup()
  const target = await ctx.mydotEvidence.setTarget(agent.id, input)
  const error = new Error('GitHub unavailable')
  if (phase === 'lookup') transport.resolveExecutable.mockRejectedValueOnce(error)
  if (phase === 'spawn') transport.spawn.mockImplementationOnce(() => { throw error })
  if (phase === 'completion') transport.spawn.mockImplementationOnce(() => handle(JSON.stringify(run), 0, false, Promise.reject(error)))
  await ctx.mydotEvidence.refresh(agent.id, target.seq, run.id, new AbortController().signal)
  expect(await view()).toMatchObject({ status: 'unavailable', history: [{ observation: { reason: 'provider-unavailable' } }] })
})

it('records an already cancelled read without resolving or spawning the GitHub CLI', async () => {
  const { ctx, agent, input, transport, view } = await setup()
  const target = await ctx.mydotEvidence.setTarget(agent.id, input)
  await ctx.mydotEvidence.refresh(agent.id, target.seq, run.id, AbortSignal.abort())
  expect(transport.resolveExecutable).not.toHaveBeenCalled()
  expect(transport.spawn).not.toHaveBeenCalled()
  expect(await view()).toMatchObject({ status: 'unavailable', history: [{ observation: { reason: 'cancelled' } }] })
})

it('applies its deployment deadline to executable resolution and retains cancellation', async () => {
  const { ctx, agent, input, transport, config, view } = await setup()
  const target = await ctx.mydotEvidence.setTarget(agent.id, input)
  const entered = Promise.withResolvers<undefined>()
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  transport.resolveExecutable.mockImplementationOnce(async (_command, _env, signal) => {
    if (signal === undefined) throw new Error('Missing operation lifetime')
    entered.resolve(undefined)
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('Executable lookup cancelled')) }, { once: true })
    })
    return '/fixture/gh'
  })
  const refresh = ctx.mydotEvidence.refresh(agent.id, target.seq, run.id, new AbortController().signal)
  await entered.promise
  expect(timeout).toHaveBeenCalledWith(config.timeoutMs)
  deadline.abort(new DOMException('deadline expired', 'TimeoutError'))
  await refresh
  expect(transport.spawn).not.toHaveBeenCalled()
  expect(await view()).toMatchObject({ status: 'unavailable', history: [{ observation: { reason: 'cancelled' } }] })
})

it('drains an in-flight CLI before plugin disposal settles and rejects later operations', async () => {
  const { ctx, agent, input, transport, fiber, config } = await setup()
  const service = ctx.mydotEvidence
  const target = await service.setTarget(agent.id, input)
  const started = Promise.withResolvers<AbortSignal>()
  const exit = Promise.withResolvers<SubprocessOutcome>()
  transport.spawn.mockImplementationOnce((spec) => {
    if (spec.signal === undefined) throw new Error('Missing subprocess lifetime')
    started.resolve(spec.signal)
    return handle(JSON.stringify(run), 0, false, exit.promise)
  })
  const refresh = service.refresh(agent.id, target.seq, run.id, new AbortController().signal)
  const lifetime = await started.promise
  const aborted = Promise.withResolvers<undefined>()
  lifetime.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
  let disposed = false
  const disposal = fiber.dispose().then(() => { disposed = true })
  await aborted.promise
  try {
    expect(disposed).toBe(false)
  } finally {
    exit.resolve({ exitCode: 0, signal: null })
  }
  await Promise.all([refresh, disposal])
  expect(disposed).toBe(true)
  await expect(service.setTarget(agent.id, input)).rejects.toThrow()
  expect(ctx.sessionProjections.stateOf(agent.session, 'mydotEvidence')).toBeUndefined()
  await ctx.plugin(MyDotEvidence, config)
  using source = await ctx.sessionQuery.observeSession(agent.id)
  expect(await ctx.mydotEvidence.view(source)).toMatchObject({ status: 'unavailable', history: [{ observation: { reason: 'cancelled' } }] })
})

it('keeps an in-flight result historical after target replacement and serializes the next read', async () => {
  const { ctx, agent, input, transport, view } = await setup()
  const service = ctx.mydotEvidence
  const firstTarget = await service.setTarget(agent.id, input)
  const firstEntered = Promise.withResolvers<undefined>()
  const firstRelease = Promise.withResolvers<undefined>()
  const secondEntered = Promise.withResolvers<undefined>()
  const secondRelease = Promise.withResolvers<undefined>()
  transport.resolveExecutable.mockImplementationOnce(async () => {
    firstEntered.resolve(undefined); await firstRelease.promise; return '/fixture/gh'
  })
  const first = service.refresh(agent.id, firstTarget.seq, run.id, new AbortController().signal)
  await firstEntered.promise
  const secondTarget = await service.setTarget(agent.id, { ...input, commit: 'b'.repeat(40) })
  const second = service.refresh(agent.id, secondTarget.seq, 789, new AbortController().signal)
  expect(transport.resolveExecutable).toHaveBeenCalledTimes(1)
  let secondStarted = false
  transport.spawn.mockImplementation((spec) => {
    const endpoint = spec.argv[6]!
    if (endpoint.includes('/actions/runs/789')) {
      const output = JSON.stringify(endpoint.includes('/jobs?')
        ? { jobs: [{ ...job, run_id: 789, head_sha: secondTarget.commit }] }
        : { ...run, id: 789, head_sha: secondTarget.commit })
      if (!secondStarted) {
        secondStarted = true
        secondEntered.resolve(undefined)
        return handle(output, 0, false, secondRelease.promise.then(() => ({ exitCode: 0, signal: null })))
      }
      return handle(output)
    }
    return handle(JSON.stringify(response(spec)))
  })
  firstRelease.resolve(undefined)
  await first
  await secondEntered.promise
  expect(await view()).toMatchObject({ target: { commit: secondTarget.commit }, status: 'unobserved', history: [{ current: false, target: { commit } }] })
  secondRelease.resolve(undefined)
  await second
  expect(await view()).toMatchObject({ status: 'passed', history: [{ current: false }, { current: true, target: { commit: secondTarget.commit } }] })
})

it('continues a queued refresh after the preceding durability checkpoint rejects', async () => {
  const { ctx, agent, input, view } = await setup()
  const target = await ctx.mydotEvidence.setTarget(agent.id, input)
  vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk unavailable'))
  const first = ctx.mydotEvidence.refresh(agent.id, target.seq, run.id, new AbortController().signal)
  const failure = expect(first).rejects.toThrow('disk unavailable')
  const second = ctx.mydotEvidence.refresh(agent.id, target.seq, run.id, new AbortController().signal)
  await Promise.all([failure, second])
  expect(await view()).toMatchObject({ status: 'passed', history: [{ current: true }, { current: true }] })
})

it('requires persisted evidence even when a flush listener participates without an active writer', async () => {
  const { ctx, transport } = await setup()
  const session = ctx.sessions.create(SessionId('without-active-writer'))
  const request = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the parser' }] }), { surfaceOp: 'append' })
  const stored = await ctx.sessionPersistence.create(session.header)
  await stored.append([request])
  await stored.flush()
  await stored.close()
  // The actual JSONL listener participates but has no writer to drain for this Session.
  expect(await ctx.sessions.flush(session)).toBe(true)
  await expect(ctx.mydotEvidence.setTarget(session.id, { requestSeq: request.seq, checkId: check.id, commit })).rejects.toMatchObject({ code: 'not-durable' })
  using source = await ctx.sessionQuery.observeSession(session.id)
  expect(await ctx.mydotEvidence.view(source)).toMatchObject({ status: 'unavailable', target: null, history: [] })
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('rejects a retained live cut after its owner closes and after the same stored Session resumes', async () => {
  const { ctx, agent, owner, input } = await setup()
  await ctx.mydotEvidence.setTarget(agent.id, input)
  using previous = await ctx.sessionQuery.observeSession(agent.id)
  await owner.dispose()
  await expect(ctx.mydotEvidence.view(previous)).rejects.toMatchObject({ code: 'session-unavailable' })
  const resumed = await ctx.agents.resume({ resumeSessionId: agent.id })
  expect(resumed.agent.session.header).not.toBe(previous.header)
  await expect(ctx.mydotEvidence.view(previous)).rejects.toMatchObject({ code: 'session-unavailable' })
  using current = await ctx.sessionQuery.observeSession(agent.id)
  expect(await ctx.mydotEvidence.view(current)).toMatchObject({ status: 'unobserved', target: { commit } })
})

it('withholds a prepared cut after another live owner reuses its Session ID', async () => {
  const { ctx, agent, owner, input } = await setup()
  await ctx.mydotEvidence.setTarget(agent.id, input)
  await owner.dispose()
  using previous = await ctx.sessionQuery.observeSession(agent.id)
  expect(previous.source).toBe('prepared')
  ctx.sessions.create(agent.id)
  expect(await ctx.mydotEvidence.view(previous)).toMatchObject({ status: 'unavailable', target: null, history: [] })
})

it('rejects an in-flight observation if another live owner has reused its Session ID', async () => {
  const { ctx, agent, owner, input, transport } = await setup()
  const target = await ctx.mydotEvidence.setTarget(agent.id, input)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  transport.resolveExecutable.mockImplementationOnce(async () => {
    entered.resolve(undefined); await release.promise; return '/fixture/gh'
  })
  const refresh = ctx.mydotEvidence.refresh(agent.id, target.seq, run.id, new AbortController().signal)
  const rejected = expect(refresh).rejects.toMatchObject({ code: 'stale-target' })
  await entered.promise
  try {
    await owner.dispose()
    ctx.sessions.create(agent.id)
  } finally { release.resolve(undefined) }
  await rejected
  using current = await ctx.sessionQuery.observeSession(agent.id)
  expect(await ctx.mydotEvidence.view(current)).toMatchObject({ status: 'unobserved', target: null, history: [] })
})

it('recovers a queued valid selection after rejecting the preceding invalid selection', async () => {
  const { ctx, agent, input, view } = await setup()
  const invalid = ctx.mydotEvidence.setTarget(agent.id, { ...input, requestSeq: SessionSeq(999) })
  const rejected = expect(invalid).rejects.toMatchObject({ code: 'invalid-target' })
  const selected = ctx.mydotEvidence.setTarget(agent.id, input)
  await rejected
  expect((await selected).commit).toBe(commit)
  expect(await view()).toMatchObject({ status: 'unobserved', target: { commit } })
})

it('shares a pending snapshot checkpoint and retries a newer prefix after that checkpoint fails', async () => {
  const { ctx, agent, input } = await setup()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<boolean>()
  const checkpoint = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(() => {
    entered.resolve(undefined); return release.promise
  })
  const selection = ctx.mydotEvidence.setTarget(agent.id, input)
  const rejected = expect(selection).rejects.toThrow('checkpoint unavailable')
  await entered.promise
  using initial = await ctx.sessionQuery.observeSession(agent.id)
  const initialView = ctx.mydotEvidence.view(initial)
  agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the public API stable' }] }), { surfaceOp: 'append' })
  using newer = await ctx.sessionQuery.observeSession(agent.id)
  const newerView = ctx.mydotEvidence.view(newer)
  expect(checkpoint).toHaveBeenCalledTimes(1)
  release.reject(new Error('checkpoint unavailable'))
  await rejected
  expect(await initialView).toMatchObject({ status: 'unavailable', target: null })
  expect(await newerView).toMatchObject({ status: 'unobserved', target: { commit }, requests: [{ text: 'Fix the parser' }, { text: 'Keep the public API stable' }] })
  expect(checkpoint).toHaveBeenCalledTimes(2)
})

it('rejects a live checkpoint whose observation begins after its owner has closed', async () => {
  const { ctx, agent, owner, input } = await setup()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return observe(...args)
  })
  const selection = ctx.mydotEvidence.setTarget(agent.id, input)
  const rejected = expect(selection).rejects.toMatchObject({ code: 'not-durable' })
  await entered.promise
  try { await owner.dispose() } finally { release.resolve(undefined) }
  await rejected
  expect((await ctx.mydotEvidence.setTarget(agent.id, input)).commit).toBe(commit)
})

it('rejects evidence when a participating flush listener has no persistence provider', async () => {
  const { ctx, agent, input, view } = await setup({}, false)
  ctx.on('session/flush', () => undefined)
  await expect(ctx.mydotEvidence.setTarget(agent.id, input)).rejects.toMatchObject({ code: 'not-durable' })
  expect(await view()).toMatchObject({ status: 'unavailable', target: null, history: [] })
})
