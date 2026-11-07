import { describe, expect, it } from 'vitest'
import { ProbabilitySeries } from '../src/detector.ts'

const policy = { probabilityThreshold: 0.999, minRunTokens: 4, minTailTokens: 2 }
const token = (text: string, p = 1) => ({
  token: text, bytes: [...Buffer.from(text)], logprob: Math.log(p), top_logprobs: [{ token: text, logprob: Math.log(p) }],
})
function event(text: string, tokens: unknown[], channel = 'content') { return { choices: [{ index: 0, delta: { [channel]: text }, logprobs: { content: tokens } }] } }

describe('visible probability series', () => {
  it('keeps the model-token run continuous across adjacent provider text deltas', () => {
    const series = new ProbabilitySeries(10000)
    series.observe(event('ab', [token('a'), token('b')]))
    series.observe(event('cd', [token('c'), token('d')]))
    expect(series.finish(policy).candidates).toEqual([{ channel: 'content', text: 'abcd', tokens: 4 }])
  })

  it('retains incomplete coverage for malformed, non-JSON and nonprimary choice events', () => {
    const badInputs = [undefined, 1n, { choices: [{ index: 1, delta: { content: 'other' } }] },
      { choices: [{ index: 0, logprobs: { content: [{ bytes: [999] }] } }] }]
    for (const input of badInputs) {
      const series = new ProbabilitySeries(10000)
      series.observe(input)
      expect(series.finish(policy).complete).toBe(false)
    }
    const missingBytes = new ProbabilitySeries(10000)
    missingBytes.observe(event('ab', [{ top_logprobs: [] }]))
    missingBytes.observe(event('cd', [], 'reasoning_content'))
    expect(missingBytes.finish(policy)).toMatchObject({ complete: false, unmatchedBytes: 4, unattributedTokens: 1 })
    const bounded = new ProbabilitySeries(1)
    bounded.observe(event('large', []))
    bounded.observe(event('ignored', []))
    expect(bounded.finish(policy)).toMatchObject({ overflowed: true, content: '' })
  })


  it('separates reasoning/content and excludes invisible template tokens', () => {
    const series = new ProbabilitySeries(10000)
    series.observe(event('abcd', [...'abcd'].map(x => token(x)), 'reasoning_content'))
    series.observe(event('', Array.from({ length: 40 }, () => token('<invoke>'))))
    series.observe(event('okay', [...'okay'].map(x => token(x, 0.5))))
    const result = series.finish(policy)
    expect(result.candidates).toMatchObject([{ channel: 'reasoning', text: 'abcd', tokens: 4 }])
    expect(result.unattributedTokens).toBe(40)
    expect(result.visibleTokens).toBe(8)
    expect(result.complete).toBe(true)
  })

  it('evaluates a short high-probability tail and never joins different channels', () => {
    const series = new ProbabilitySeries(10000)
    series.observe(event('ab', [token('a'), token('b')], 'reasoning_content'))
    series.observe(event('cd', [token('c'), token('d')]))
    expect(series.finish(policy).candidates.map(value => value.tokens)).toEqual([2, 2])
  })

  it('matches UTF-8 bytes across chunks without reclassifying native tool arguments', () => {
    const series = new ProbabilitySeries(10000)
    const bytes = [...Buffer.from('界')]
    series.observe(event('界', [{ ...token('partial'), bytes: bytes.slice(0, 1) }]))
    series.observe(event('', [{ ...token('partial'), bytes: bytes.slice(1) }]))
    series.observe({ choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '{x:1}' } }] }, logprobs: { content: [token('<tool>')] } }] })
    const result = series.finish(policy)
    expect(result.visibleTokens).toBe(2)
    expect(result.unattributedTokens).toBe(1)
    expect(result.complete).toBe(true)
    expect(result.candidates[0]?.text).toBe('界')
  })

  it('preserves missing observations, missing top probabilities and capture bounds', () => {
    const absent = new ProbabilitySeries(10000)
    absent.observe(event('not covered', []))
    expect(absent.finish(policy)).toMatchObject({ complete: false, visibleTokens: 0 })
    const missing = new ProbabilitySeries(10000)
    missing.observe(event('x', [{ token: 'x', bytes: [120], logprob: 0 }]))
    expect(missing.finish(policy)).toMatchObject({ complete: false, missingTokens: 1, candidates: [] })
    const bounded = new ProbabilitySeries(1)
    bounded.observe(event('large', [token('large')]))
    expect(bounded.finish(policy)).toMatchObject({ complete: false, overflowed: true })
  })

  it('does not skip visible text to find an attractive later token match', () => {
    const series = new ProbabilitySeries(10000)
    series.observe(event('ab', [token('b')]))
    expect(series.finish(policy)).toMatchObject({ complete: false, visibleTokens: 0, unattributedTokens: 1 })
  })
})
