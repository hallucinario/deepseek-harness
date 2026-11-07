import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

describe('pi-ai probability observation', () => {
  it.each([0, 6, 1.5, Infinity, NaN])('rejects invalid top-k policy %s before dispatch', (probabilityTopK) => {
    expect(() => resolveProfiles({ local: { api: 'openai-completions', baseURL: 'https://unused.test',
      probabilityTopK, models: [{ id: 'm' }] } })).toThrow('probabilityTopK')
  })

  it('forwards sampling, preserves raw probabilities and awaits a request-correlated wrapper', async () => {
    const raw = { choices: [{ index: 0, delta: { content: 'hello' }, logprobs: { content: [{ token: 'hello', bytes: [104, 101, 108, 108, 111], logprob: -0.01, top_logprobs: [{ token: 'hello', logprob: -0.01 }] }] }, finish_reason: null }] }
    const server = await mockServer([{ events: [JSON.stringify(raw), JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), '[DONE]'] }])
    const request: GenerateOptions = { provider: 'local', model: 'm', messages: [] }
    const seen: unknown[] = []
    let wrapped: GenerateOptions | undefined
    let settled = false
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ local: { api: 'openai-completions', baseURL: server.url, probabilityTopK: 5, models: [{ id: 'm', contextWindow: 8192, maxTokens: 1024 }] } }),
      resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth(),
      onProviderStreamEvent: async (options, data) => { expect(options).toBe(wrapped); await Promise.resolve(); seen.push(data) },
      wrapStream: (options, next) => (async function* () { wrapped = options; yield* next(); await Promise.resolve(); settled = true })(),
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(request)) chunks.push(chunk)
    expect(settled).toBe(true)
    expect(wrapped).toBe(request)
    expect(seen).toContainEqual(raw)
    expect(server.requests[0]).toMatchObject({ logprobs: true, top_logprobs: 5 })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('does not enable probability sampling on an unconfigured route', async () => {
    const server = await mockServer([{ events: [JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]'] }])
    const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ local: { api: 'openai-completions', baseURL: server.url, models: [{ id: 'm', contextWindow: 8192, maxTokens: 1024 }] } }), resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth() })
    for await (const _chunk of adapter.stream({ provider: 'local', model: 'm', messages: [] })) { /* Drain SDK. */ }
    expect(server.requests[0]).not.toHaveProperty('logprobs')
  })
})
