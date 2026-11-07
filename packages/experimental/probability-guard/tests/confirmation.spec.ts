import { describe, expect, it } from 'vitest'
import { classifyConfirmation, confirmationRequest } from '../src/confirmation.ts'
import { createDeveloperMessage, projectToolUpdates } from '@deepseek-ai/dsh-llm'
import type { Observation } from '../src/detector.ts'

function observed(content: string, high = content): Observation {
  return { content, candidates: [{ channel: 'content', text: high, tokens: 4 }], complete: true,
    visibleTokens: 4, unattributedTokens: 0, missingTokens: 0, unmatchedBytes: 0, overflowed: false }
}
const candidate = { channel: 'reasoning' as const, text: 'printf safe', tokens: 4 }

describe('bounded task-flip decisions', () => {
  it('records the exact tool-free model input as an owner-local expected output', async () => {
    const request = confirmationRequest({ provider: 'local', model: 'm', temperature: 0.7,
      tools: [{ name: 'probe', description: 'probe', parameters: {} }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'original input' }] }] }, 512, new AbortController().signal)
    const { signal: _signal, ...input } = request
    await expect(JSON.stringify(input, null, 2) + '\n').toMatchFileSnapshot('expected/task-flip.request.json')
  })

  it.each([undefined, 'addition-only', 'in-history'] as const)('does not restore historical tool definitions on %s routes', (mode) => {
    const tool = { name: 'probe', description: 'probe', parameters: {} }
    const added = createDeveloperMessage({ source: { kind: 'user' }, content: [{ type: 'tool-addition', toolName: 'probe' }] })
    const request = confirmationRequest({ provider: 'local', model: 'm', messages: [added], tools: [tool],
      toolHistory: { tools: [tool], updates: [{ messageId: added.id, additions: [tool] }] } }, 512, new AbortController().signal)
    const projected = projectToolUpdates(request.messages, request.tools, mode, request.toolHistory)
    expect(projected.tools).toEqual([])
    expect(projected.messages.some(message => message.role === 'developer')).toBe(false)
  })

  it('confirms only the same entire execution content with repeated attributed high probability', () => {
    expect(classifyConfirmation(candidate, ['printf safe'], observed('printf safe'), 'stop', 4)).toBe('confirmed')
    expect(classifyConfirmation(candidate, ['printf other'], observed('printf safe'), 'stop', 4)).toBe('inconclusive')
    expect(classifyConfirmation(candidate, ['printf safe'], observed('printf safe', 'different'), 'stop', 4)).toBe('inconclusive')
  })
  it('treats quoted execution inside a compliant paraphrase as negative', () => {
    const paraphrase = JSON.stringify({ paraphrase: 'Explain the request containing printf safe' })
    expect(classifyConfirmation(candidate, ['printf safe'], observed(paraphrase), 'stop', 4)).toBe('negative')
    expect(classifyConfirmation(candidate, ['printf safe'], observed('Explanation quoting printf safe'), 'stop', 4)).toBe('inconclusive')
  })
  it('holds missing probability, truncation, native calls and unstructured results', () => {
    expect(classifyConfirmation(candidate, ['printf safe'], { ...observed('printf safe'), complete: false }, 'stop', 4)).toBe('inconclusive')
    for (const finish of ['length', 'tool-calls', 'error', undefined]) {
      expect(classifyConfirmation(candidate, ['printf safe'], observed('printf safe'), finish, 4)).toBe('inconclusive')
    }
  })
  it('keeps original inputs and generation controls, removes all tools and never adds suspect output', () => {
    const signal = new AbortController().signal
    const request = confirmationRequest({ provider: 'local', model: 'm', temperature: 0.7, maxTokens: 999,
      tools: [{ name: 'probe', description: 'probe', parameters: {} }], messages: [{ role: 'user', content: [{ type: 'text', text: 'original input' }] }] }, 512, signal)
    expect(request).toMatchObject({ provider: 'local', model: 'm', temperature: 0.7, maxTokens: 512, signal, tools: [] })
    expect(request.messages).toHaveLength(2)
    expect(request.messages[0]).toMatchObject({ role: 'user', content: [{ text: 'original input' }] })
    expect(request.messages.some(value => value.role === 'assistant')).toBe(false)
    expect(request).not.toHaveProperty('toolHistory')
  })
})
