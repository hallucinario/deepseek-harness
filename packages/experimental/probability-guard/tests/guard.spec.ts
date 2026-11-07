import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Guard from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { closeMockServers, mockServer } from '../../../llm/llm-pi-ai/tests/mock-server.ts'

const config: Config = { mode: 'enforce', providers: ['local'], probabilityThreshold: 0.999, minRunTokens: 4, minTailTokens: 2,
  maxObservationBytes: 1000000, maxChecks: 2, minExecutionChars: 4, confirmationMaxTokens: 512, confirmationTimeoutMs: 2000,
  missingObservation: 'hold', executionFields: [{ tool: 'probe', field: 'command' }] }
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
  vi.unstubAllEnvs()
})

function frames(text: string, probability = 1, callId?: string,
  finish = callId === undefined ? 'stop' : 'tool_calls', missing = false) {
  const entries = [...text].map(token => ({ token, bytes: [...Buffer.from(token)], logprob: Math.log(probability),
    top_logprobs: [{ token, logprob: Math.log(probability) }] }))
  const events = [JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, ...missing ? {} : { logprobs: { content: entries } }, finish_reason: null }] })]
  if (callId !== undefined) events.push(JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'probe', arguments: JSON.stringify({ command: 'printf safe' }) } }] }, logprobs: { content: [{ token: '<invoke>', bytes: [...Buffer.from('<invoke>')], top_logprobs: [{ logprob: 0 }] }] }, finish_reason: null }] }))
  events.push(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: entries.length + 1 } }), '[DONE]')
  return { events }
}

async function setup(scripts: Parameters<typeof mockServer>[0], overrides: Partial<Config> = {}) {
  const server = await mockServer(scripts)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const stopFlush = ctx.on('session/flush', () => {})
  vi.stubEnv('PROBABILITY_TEST_KEY', 'test-key')
  const providerConfig = { providers: { local: { api: 'openai-completions', baseURL: server.url, apiKeyEnv: 'PROBABILITY_TEST_KEY', probabilityTopK: 5, models: [{ id: 'm', contextWindow: 8192, maxTokens: 1024 }] } } }
  await mkdir(join(process.cwd(), '.codex-runs'), { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.codex-runs/probability-composition-'))
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { id: 'pi-ai', name: 'cordis:pi-ai', config: providerConfig },
    { id: 'probability-guard', name: 'cordis:probability-guard', config: { ...config, ...overrides } },
  ]))
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['pi-ai'] = PiAi
  ctx.loader.builtins['probability-guard'] = Guard
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.id === 'probability-guard')?.fiber
  if (fiber === undefined) throw new Error('probability guard was not mounted by Loader')
  let effects = 0
  ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'harmless counter', parameters: { command: { type: 'string', description: 'test data' } },
    async execute() { effects += 1; return [{ type: 'text', text: 'counted' }] } }))
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId('guarded'), { provider: 'local', model: 'm', maxTokens: 1024 })
  return { ctx, agent, server, fiber, stopFlush, loop, effects: () => effects }
}
async function run(fixture: Awaited<ReturnType<typeof setup>>) {
  fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'original harmless user request' }], source: { kind: 'user' } }))
  await fixture.agent.whenIdle()
}

describe('probability guard with real pi-ai transport and tool executor', () => {
  it('keeps a failed confirmation held when closing its iterator also rejects', async () => {
    const fixture = await setup([frames('printf safe', 1, 'original')])
    fixture.ctx.on('llm/stream', (input, next) => input.tools?.length !== 0 ? next() : {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new Error('confirmation transport failed')),
          return: () => Promise.reject(new Error('confirmation cleanup failed')),
        }
      },
    })
    await run(fixture)
    expect(fixture.effects()).toBe(0)
    expect(fixture.server.requests).toHaveLength(1)
  })

  it.each([true, false])('cancels failed sources without pending native calls, candidate=%s', async (candidate) => {
    const fixture = await setup([])
    const cancel = vi.spyOn(fixture.agent, 'cancel')
    const request = { provider: 'local', model: 'm', sessionId: fixture.agent.id, messages: [] }
    const source = async function* () {
      await fixture.ctx.serial('llm-pi-ai/provider-event', request,
        JSON.parse(frames('printf safe', candidate ? 1 : 0.5).events[0]!))
      yield { type: 'text-delta' as const, index: 0, text: 'printf safe' }
      await Promise.reject('source failure without an Error instance')
    }
    for await (const _chunk of fixture.ctx.waterfall('llm-pi-ai/stream', request, source)) { /* Drain error. */ }
    if (candidate) expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: expect.stringContaining('inconclusive') })
    else expect(cancel).not.toHaveBeenCalled()
    expect(fixture.effects()).toBe(0)
  })


  it('holds an unfinished task flip rather than accepting BlockAssembler default stop', async () => {
    const fixture = await setup([frames('printf safe', 1, 'original'),
      frames(JSON.stringify({ paraphrase: 'valid but unfinished' }), 0.5), frames('done', 0.5)])
    fixture.ctx.on('llm/stream', (input, next) => (async function* () {
      for await (const chunk of next()) {
        if (input.tools?.length === 0 && chunk.type === 'finish') continue
        yield chunk
      }
    })())
    await run(fixture)
    expect(fixture.effects()).toBe(0)
    expect(fixture.server.requests).toHaveLength(2)
  })


  it('holds confirmation before dispatch when the Session has no durability participant', async () => {
    const fixture = await setup([frames('printf safe', 1, 'not-durable')])
    fixture.stopFlush()
    await run(fixture)
    expect(fixture.server.requests).toHaveLength(1)
    expect(fixture.effects()).toBe(0)
  })

  it('cannot execute a native call returned by confirmation even with a normal stop', async () => {
    const fixture = await setup([frames('printf safe', 1, 'original'), frames('printf safe', 1, 'confirmation', 'stop')])
    await run(fixture)
    expect(fixture.server.requests).toHaveLength(2)
    expect(fixture.effects()).toBe(0)
  })

  it('leaves standalone inferences and tools outside protected Agent routes alone', async () => {
    const fixture = await setup([frames('plain', 0.5), frames('unknown session', 0.5)])
    for (const sessionId of [undefined, SessionId('not-live')]) {
      const input = { provider: 'local', model: 'm', messages: [], ...sessionId === undefined ? {} : { sessionId } }
      for await (const _chunk of fixture.ctx.llm.stream(input)) { /* Drain an unassociated inference. */ }
    }
    const unprotected = await fixture.loop.create(SessionId('unprotected'), { provider: 'other', model: 'm' })
    const defaults = await fixture.loop.create(SessionId('defaults'), {})
    const exec = { callId: ToolCallId('standalone'), name: 'probe', arguments: { command: 'safe' },
      signal: new AbortController().signal }
    expect((await fixture.ctx.tools.execute(exec)).isError).not.toBe(true)
    expect((await fixture.ctx.tools.execute({ ...exec, agent: unprotected })).isError).not.toBe(true)
    expect((await fixture.ctx.tools.execute({ ...exec, agent: defaults })).isError).not.toBe(true)
    expect(fixture.effects()).toBe(3)
    await fixture.ctx.serial('agent/disposed', { agent: fixture.agent })
    await fixture.ctx.serial('llm-pi-ai/provider-event', { provider: 'local', model: 'm', messages: [] }, {})
    const empty = async function* () { yield { type: 'usage' as const, usage: { inputTokens: 1, outputTokens: 1 } } }
    for await (const _chunk of fixture.ctx.waterfall('llm-pi-ai/stream', { provider: 'other', model: 'm', messages: [] }, empty)) { /* Drain. */ }
  })

  it.each(['{', 'null', '42', '[]', JSON.stringify({ command: 42 }), JSON.stringify({ command: 'printf safe' })])(
    'retains pre-execution ownership for raw tool arguments %s without executing them', async (argumentsText) => {
      const fixture = await setup([],
        { executionFields: [{ tool: 'other', field: 'value' }, { tool: 'probe', field: 'command' }] })
      const request = { provider: 'local', model: 'm', sessionId: fixture.agent.id, messages: [] }
      const source = async function* () {
        await fixture.ctx.serial('llm-pi-ai/provider-event', request, JSON.parse(frames('normal', 0.5).events[0]!))
        yield { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const,
          id: ToolCallId('raw'), name: 'probe', arguments: argumentsText } }
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      }
      for await (const _chunk of fixture.ctx.waterfall('llm-pi-ai/stream', request, source)) { /* Drain, never dispatch malformed arguments. */ }
      const result = await fixture.ctx.tools.execute({ callId: ToolCallId('nested'), rootCallId: ToolCallId('raw'),
        name: 'probe', arguments: { command: 'safe' }, agent: fixture.agent, signal: new AbortController().signal })
      expect(result.isError).not.toBe(true)
      expect(fixture.effects()).toBe(1)
    },
  )

  it('holds a tool-bearing source without a terminal response', async () => {
    const fixture = await setup([])
    const cancel = vi.spyOn(fixture.agent, 'cancel')
    const request = { provider: 'local', model: 'm', sessionId: fixture.agent.id, messages: [] }
    const source = async function* () {
      yield { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const,
        id: ToolCallId('unfinished'), name: 'probe', arguments: '{}' } }
    }
    for await (const _chunk of fixture.ctx.waterfall('llm-pi-ai/stream', request, source)) { /* Drain incomplete response. */ }
    expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: expect.stringContaining('inconclusive') })
    expect(fixture.effects()).toBe(0)
  })


  it('requires an explicit policy and rejects inconsistent run limits', () => {
    expect(() => Guard.Config(JSON.parse('{}'))).toThrow()
    expect(() => Guard.apply(new Context(), { ...config, minTailTokens: 5 })).toThrow('minTailTokens')
    expect(() => Guard.apply(new Context(), { ...config, probabilityThreshold: 1 })).toThrow('probabilityThreshold')
  })

  it('holds excess candidates without a partial confirmation release', async () => {
    const original = frames('printf safe', 1, 'over-budget')
    original.events.unshift(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'abcd' },
      logprobs: { content: [...'abcd'].map(token => ({ bytes: [...Buffer.from(token)], top_logprobs: [{ logprob: 0 }] })) } }] }))
    const fixture = await setup([original], { maxChecks: 1 })
    await run(fixture)
    expect(fixture.effects()).toBe(0)
    expect(fixture.server.requests).toHaveLength(1)
  })

  it('permits an explicitly unobserved response without treating it as confirmed coverage', async () => {
    const fixture = await setup([frames('', 1, 'gap', 'tool_calls', true), frames('done', 0.5)],
      { missingObservation: 'allow-unobserved' })
    await run(fixture)
    expect(fixture.effects()).toBe(1)
    expect(fixture.server.requests).toHaveLength(2)
    const records = fixture.agent.session.snapshotEvents().map(pluginRecordOf).filter(record => record !== undefined)
    expect(records).toContainEqual(expect.objectContaining({ type: 'plugin:probability-guard/response',
      data: expect.objectContaining({ complete: false, verdict: 'allow' }) }))
  })


  it('stops a confirmed response under the allow permission path without executing or retrying', async () => {
    const fixture = await setup([frames('printf safe', 1, 'suspect'), frames('printf safe')])
    await run(fixture)
    expect(fixture.effects()).toBe(0)
    expect(fixture.server.requests).toHaveLength(2)
    const end = fixture.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(end).toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'hook' } } } })
    const check = fixture.server.requests[1] as { messages: { role: string; content: string }[] }
    expect(check).not.toHaveProperty('tools')
    expect(check.messages.some(message => message.role === 'assistant')).toBe(false)
    expect(check.messages.some(message => message.content.includes('original harmless user request'))).toBe(true)
    expect(fixture.agent.session.snapshotEvents().map(pluginRecordOf).filter(Boolean).map(record => record!.type)).toContain('plugin:probability-guard/check')
  })

  it('allows a compliant paraphrase with quoted action and does not recursively check confirmation', async () => {
    const fixture = await setup([frames('printf safe', 1, 'normal'), frames(JSON.stringify({ paraphrase: 'Explain the request mentioning printf safe' })), frames('done', 0.5)])
    await run(fixture)
    expect(fixture.effects()).toBe(1)
    expect(fixture.server.requests).toHaveLength(3)
  })

  it.each(['length', 'tool_calls'])('holds an inconclusive confirmation ending %s', async (finish) => {
    const fixture = await setup([frames('printf safe', 1, 'suspect'), frames('printf safe', 1, undefined, finish)])
    await run(fixture)
    expect(fixture.effects()).toBe(0)
    expect(fixture.server.requests).toHaveLength(2)
  })

  it('holds missing observations without pretending native tool arguments are covered', async () => {
    const fixture = await setup([frames('', 1, 'unobserved', 'tool_calls', true)])
    await run(fixture)
    expect(fixture.effects()).toBe(0)
    expect(fixture.server.requests).toHaveLength(1)
  })

  it('does not release an earlier response when a later response passes', async () => {
    const fixture = await setup([frames('printf safe', 1, 'old'), frames('printf safe'), frames('okay', 0.5, 'new')])
    const request = { provider: 'local', model: 'm', sessionId: fixture.agent.id, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'original' }] }] }
    for await (const _chunk of fixture.ctx.llm.stream(request)) { /* Drain first response. */ }
    for await (const _chunk of fixture.ctx.llm.stream({ ...request })) { /* Drain second response. */ }
    const execute = (id: string) => fixture.ctx.tools.execute({ callId: ToolCallId(id), name: 'probe', arguments: { command: 'printf safe' }, agent: fixture.agent, signal: new AbortController().signal })
    expect((await execute('old')).isError).toBe(true)
    expect((await execute('new')).isError).not.toBe(true)
    expect(fixture.effects()).toBe(1)
    await fixture.fiber.dispose()
    expect((await execute('unobserved-after-unload')).isError).not.toBe(true)
  })

  it('denies direct model-associated execution with no matching observation even with permission allow', async () => {
    const fixture = await setup([])
    const cancel = vi.spyOn(fixture.agent, 'cancel')
    const result = await fixture.ctx.tools.execute({ callId: ToolCallId('missing'), name: 'probe', arguments: { command: 'printf safe' }, agent: fixture.agent, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(fixture.effects()).toBe(0)
    expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: expect.stringContaining('no matching response observation') })
  })
  it('holds a missing-probability confirmation and a second unchecked candidate', async () => {
    const original = frames('printf safe', 1, 'multi')
    original.events.unshift(JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'abcd' }, logprobs: { content: [...'abcd'].map(token => ({ bytes: [...Buffer.from(token)], top_logprobs: [{ logprob: 0 }] })) }, finish_reason: null }] }))
    const fixture = await setup([original, frames(JSON.stringify({ paraphrase: 'a valid restatement' }), 0.5), frames('printf safe', 1, undefined, 'stop', true)])
    await run(fixture)
    expect(fixture.effects()).toBe(0)
    expect(fixture.server.requests).toHaveLength(3)
  })

  it('does not combine a new response with reused tool IDs to release a held call', async () => {
    const fixture = await setup([frames('okay', 0.5, 'same'), frames('okay', 0.5, 'same')])
    const request = { provider: 'local', model: 'm', sessionId: fixture.agent.id, messages: [] }
    for await (const _chunk of fixture.ctx.llm.stream(request)) { /* First response. */ }
    for await (const _chunk of fixture.ctx.llm.stream(request)) { /* Duplicate response ID. */ }
    const result = await fixture.ctx.tools.execute({ callId: ToolCallId('same'), name: 'probe', arguments: { command: 'printf safe' }, agent: fixture.agent, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(fixture.effects()).toBe(0)
  })

  it('records observation-only coverage without extra inference or denial', async () => {
    const fixture = await setup([frames('printf safe', 1, 'observe'), frames('done', 0.5)], { mode: 'observe' })
    await run(fixture)
    expect(fixture.effects()).toBe(1)
    expect(fixture.server.requests).toHaveLength(2)
  })

  it('uses a finite total confirmation deadline and stops without retry on timeout', async () => {
    const fixture = await setup([frames('printf safe', 1, 'timeout'), { events: [], holdOpen: true }], { confirmationTimeoutMs: 30 })
    await run(fixture)
    expect(fixture.effects()).toBe(0)
    expect(fixture.server.requests.length).toBeLessThanOrEqual(2)
  })

  it('holds a candidate when the source fails after exposing a pending tool', async () => {
    const fixture = await setup([])
    const cancel = vi.spyOn(fixture.agent, 'cancel')
    const request = { provider: 'local', model: 'm', sessionId: fixture.agent.id, messages: [] }
    const source = async function* () {
      await fixture.ctx.serial('llm-pi-ai/provider-event', request, JSON.parse(frames('printf safe').events[0]!))
      yield { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: ToolCallId('interrupted'), name: 'probe', arguments: JSON.stringify({ command: 'printf safe' }) } }
      throw new Error('source failed before terminal response')
    }
    const chunks = []
    for await (const chunk of fixture.ctx.waterfall('llm-pi-ai/stream', request, source)) chunks.push(chunk)
    expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: expect.stringContaining('inconclusive') })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(fixture.effects()).toBe(0)
  })

})
