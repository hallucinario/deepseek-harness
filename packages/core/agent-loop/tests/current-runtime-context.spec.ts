import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmError, type ContextFormed, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, Session, SessionId, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { MockAdapter, textResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'other-current-context': { kind: 'other-current-context' } & ContextFormed
  }
}

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(adapter = new MockAdapter(Array.from({ length: 8 }, () => textResponse('ok')))) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function textOf(request: GenerateOptions | undefined): string {
  return request?.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n') ?? ''
}

describe('current runtime context', () => {
  it('replaces current sections while preserving historical sections and raw logged values', async () => {
    const { ctx, adapter } = await harness()
    let history = 'Historical fact one.'
    let current = 'Memory revision A.'
    ctx.systemPrompt.context({ name: 'history', order: 0, text: () => history })
    ctx.systemPrompt.context({ name: 'memory-experience', order: 1, retention: 'current', text: () => current })
    const agent = await ctx.agentLoop.create(SessionId('current-mixed'), { provider: 'mock', model: 'mock' })
    await send(agent, 'first')
    const original = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
    if (original?.type !== 'user/message') throw new Error('missing original runtime context')
    const marker = agent.session.snapshotEvents().find(event => event.type === 'runtime-context/current-enabled')
    expect(marker).toMatchObject({ data: { retention: 'current' } })
    expect(marker?.ignorable).toBeUndefined()
    expect(marker?.seq).toBeLessThan(original.seq)

    history = 'Historical fact two.'
    current = 'Memory revision B.'
    await send(agent, 'second')
    const text = textOf(adapter.requests[1])
    expect(text).toContain('Historical fact one.')
    expect(text).toContain('Historical fact two.')
    expect(text).not.toContain('Memory revision A.')
    expect(text.match(/Memory revision B\./g)).toHaveLength(1)
    expect(original.data.content).toHaveLength(1)
    expect(original.data.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(original.data.content)).toContain('Memory revision A.')
    expect(agent.session.snapshotEvents().some(event => isReplacementSurfaceEvent(event)
      && event.sourceEventSeqs?.includes(original.seq))).toBe(true)
    const replay = Session.create(agent.session.id, agent.session.snapshotEvents())
    const lastAssistant = replay.deriveMessages().at(-1)
    expect(lastAssistant?.role).toBe('assistant')
    expect(replay.deriveMessages().slice(0, -1)).toEqual(adapter.requests[1]?.messages)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'runtime-context/current-enabled')).toHaveLength(1)
  })

  it('keeps unchanged current context in place without accumulating replacement records', async () => {
    const { ctx, adapter } = await harness()
    ctx.systemPrompt.context({ name: 'memory-experience', order: 0, retention: 'current', text: 'Unchanged memory.' })
    const agent = await ctx.agentLoop.create(SessionId('current-unchanged'), { provider: 'mock', model: 'mock' })
    await send(agent, 'first')
    await send(agent, 'second')
    expect(textOf(adapter.requests[1]).match(/Unchanged memory\./g)).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(isReplacementSurfaceEvent)).toHaveLength(0)
  })

  it('records no retention marker or runtime input when route preparation is cancelled', async () => {
    const { ctx, adapter } = await harness()
    ctx.systemPrompt.context({ name: 'memory-experience', order: 0, retention: 'current', text: 'Never admitted.' })
    ctx.on('agent/request', ({ agent }, next) => { agent.cancel({ kind: 'user' }); return next() })
    const agent = await ctx.agentLoop.create(SessionId('current-cancelled'), { provider: 'mock', model: 'mock' })
    await send(agent, 'cancel this')
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'runtime-context/current-enabled' || event.type === 'user/message')).toBe(false)
  })

  it('refuses current-retention logs under the released event vocabulary before adoption', async () => {
    const { ctx } = await harness()
    ctx.systemPrompt.context({ name: 'memory-experience', order: 0, retention: 'current', text: 'Required retention.' })
    const agent = await ctx.agentLoop.create(SessionId('current-reader-refusal'), { provider: 'mock', model: 'mock' })
    await send(agent, 'first')
    const marker = agent.session.snapshotEvents().find(event => event.type === 'runtime-context/current-enabled')
    if (marker === undefined) throw new Error('missing required retention marker')
    const released = new Set(KNOWN_SESSION_EVENT_TYPES)
    released.delete('runtime-context/current-enabled')
    const has = vi.spyOn(KNOWN_SESSION_EVENT_TYPES, 'has').mockImplementation(type => released.has(type))
    try {
      const required = structuredClone(marker)
      expect(() => validateStoredEvents(agent.session.header, [required])).toThrow(SessionFormatUnsupportedError)
      expect(Object.isFrozen(required)).toBe(false)
      const ignorable = { ...structuredClone(marker), ignorable: true as const }
      expect(validateStoredEvents(agent.session.header, [ignorable])).toEqual([ignorable])
    } finally {
      has.mockRestore()
    }
  })

  it('clears every older current owner while preserving each mixed historical contribution', async () => {
    const { ctx, adapter } = await harness()
    ctx.systemPrompt.context({ name: 'memory-experience', order: 0, retention: 'current', text: 'Live memory.' })
    const agent = await ctx.agentLoop.create(SessionId('current-multiple-old-owners'), { provider: 'mock', model: 'mock' })
    await send(agent, 'first')
    for (const name of ['old-one', 'old-two']) {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `History ${name}. Stale ${name}.` }],
        source: { kind: 'runtime-context', form: 'snapshot', sections: [
          { name: `history-${name}`, text: `History ${name}.` },
          { name, text: `Stale ${name}.`, retention: 'current' },
        ] },
      }), { surfaceOp: 'append' })
    }
    await send(agent, 'second')
    const text = textOf(adapter.requests[1])
    expect(text).toContain('History old-one.')
    expect(text).toContain('History old-two.')
    expect(text).not.toContain('Stale old-one.')
    expect(text).not.toContain('Stale old-two.')
    expect(text.match(/Live memory\./g)).toHaveLength(1)
  })

  it.each(['empty', 'removed', 'suppressed'] as const)('clears current-only context when its provider is %s during request preparation', async (change) => {
    const { ctx, adapter } = await harness()
    let current = 'Memory before clear.'
    const dispose = ctx.systemPrompt.context({ name: 'memory-experience', order: 0, retention: 'current', text: () => current })
    const agent = await ctx.agentLoop.create(SessionId(`current-clear-${change}`), { provider: 'mock', model: 'mock' })
    await send(agent, 'first')
    ctx.on('agent/request', (_payload, next) => {
      if (change === 'removed') dispose()
      else if (change === 'suppressed') ctx.systemPrompt.suppressRuntimeContext()
      else current = ''
      return next()
    })
    await send(agent, 'second')
    expect(adapter.requests).toHaveLength(2)
    expect(textOf(adapter.requests[1])).not.toContain('Memory before clear.')
  })

  it('removes a disposed plugin contribution without removing other snapshot producers', async () => {
    const { ctx, adapter } = await harness()
    const provider = ctx.plugin({
      inject: ['systemPrompt'],
      apply(scope: Context) {
        scope.systemPrompt.context({ name: 'memory-experience', order: 0, retention: 'current', text: 'Disposable memory.' })
      },
    })
    await provider
    const agent = await ctx.agentLoop.create(SessionId('current-plugin-disposal'), { provider: 'mock', model: 'mock' })
    await send(agent, 'first')
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Other snapshot remains.' }],
      source: { kind: 'other-current-context', form: 'snapshot', sections: [{ name: 'other', retention: 'current', text: 'Other snapshot remains.' }] },
    }), { surfaceOp: 'append' })
    await provider.dispose()
    await send(agent, 'second')
    expect(textOf(adapter.requests[1])).not.toContain('Disposable memory.')
    expect(textOf(adapter.requests[1])).toContain('Other snapshot remains.')
  })

  it('refreshes current context on retry while admitting downstream messages once', async () => {
    let current = 'Attempt memory A.'
    const adapter = new MockAdapter([
      () => { current = 'Attempt memory B.'; throw new LlmError('retry', 'SERVER') },
      textResponse('recovered'),
    ])
    const { ctx } = await harness(adapter)
    ctx.systemPrompt.context({ name: 'memory-experience', order: 0, retention: 'current', text: () => current })
    let assemblies = 0
    let preSteps = 0
    ctx.on('system-prompt/assemble', (_assembly, _context, next) => { assemblies++; return next() })
    ctx.on('agent/pre-step', async (_payload, next) => {
      preSteps++
      const decision = await next()
      return decision.kind === 'enter' ? {
        ...decision,
        startsRequestSeries: true,
        messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: 'Downstream accepted input.' }], source: { kind: 'user' } })],
      } : decision
    })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))
    const agent = await ctx.agentLoop.create(SessionId('current-retry'), { provider: 'mock', model: 'mock' })
    await send(agent, 'first')
    expect(adapter.requests).toHaveLength(2)
    expect(textOf(adapter.requests[0])).toContain('Attempt memory A.')
    expect(textOf(adapter.requests[1])).not.toContain('Attempt memory A.')
    expect(textOf(adapter.requests[1]).match(/Attempt memory B\./g)).toHaveLength(1)
    expect(textOf(adapter.requests[1]).match(/Downstream accepted input\./g)).toHaveLength(1)
    expect(assemblies).toBe(1)
    expect(preSteps).toBe(1)
  })

  it('clears resumed current owners that are no longer registered and preserves legacy history', async () => {
    const first = await harness()
    first.ctx.systemPrompt.context({ name: 'history', order: 0, text: 'Durable historical context.' })
    first.ctx.systemPrompt.context({ name: 'memory-experience', order: 1, retention: 'current', text: 'Old resumed memory.' })
    const original = await first.ctx.agentLoop.create(SessionId('current-seed'), { provider: 'mock', model: 'mock' })
    await send(original, 'first')
    const second = await harness()
    const { agent } = await second.ctx.agents.create({
      sessionId: SessionId('current-resumed'), seed: original.session.snapshotEvents(),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await send(agent, 'continue')
    expect(textOf(second.adapter.requests[0])).not.toContain('Old resumed memory.')
    expect(textOf(second.adapter.requests[0])).toContain('Durable historical context.')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'runtime-context/current-enabled')).toHaveLength(1)
  })
})
