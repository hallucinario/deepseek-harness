/** Byte-attributed visible reasoning/content probabilities; native tool arguments remain unobserved. */
import { z } from 'zod'

/** Explicit deployment policy; no empirical threshold is implied. */
export interface DetectionPolicy {
  /** Absolute top-token probability that a token must exceed to extend a run. */
  probabilityThreshold: number
  /** Minimum contiguous visible model-token count for an ordinary candidate. */
  minRunTokens: number
  /** Minimum contiguous count at the end of a visible channel, no larger than minRunTokens. */
  minTailTokens: number
}

/** One contiguous high-probability span in one visible channel. */
export interface Candidate {
  channel: 'reasoning' | 'content'
  text: string
  tokens: number
}

/** Coverage facts remain separate from candidate decisions. */
export interface Observation {
  candidates: Candidate[]
  visibleTokens: number
  unattributedTokens: number
  missingTokens: number
  unmatchedBytes: number
  overflowed: boolean
  complete: boolean
  content: string
}

const entry = z.object({
  bytes: z.array(z.number().int().min(0).max(255)).nullable().optional(),
  top_logprobs: z.array(z.object({ logprob: z.number().finite().max(0) })).optional(),
})
const event = z.object({ choices: z.array(z.object({
  index: z.number().int(),
  delta: z.object({ content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional() }).optional(),
  logprobs: z.object({ content: z.array(entry).nullable().optional() }).nullable().optional(),
})) })

interface Segment { channel: Candidate['channel']; chunks: Buffer[] }
interface Token { bytes: Buffer; probability: number | undefined }

/** One response collector; bound includes raw provider metadata and never crosses responses. */
export class ProbabilitySeries {
  private readonly segments: Segment[] = []
  private readonly tokens: Token[] = []
  private consumed = 0
  private overflowed = false
  private invalid = false

  constructor(private readonly maxBytes: number) {}

  /**
   * Retain only validated byte/probability fields and visible deltas.
   * @param data - parsed raw provider event; unsupported or malformed events leave coverage incomplete.
   */
  observe(data: unknown): void {
    if (this.overflowed) return
    let serialized: string | undefined
    try { serialized = JSON.stringify(data) } catch (_nonJsonProviderEvent) { this.invalid = true; return }
    if (serialized === undefined) { this.invalid = true; return }
    this.consumed += Buffer.byteLength(serialized)
    if (this.consumed > this.maxBytes) { this.overflowed = true; return }
    const parsed = event.safeParse(data)
    if (!parsed.success) { this.invalid = true; return }
    for (const choice of parsed.data.choices) {
      if (choice.index !== 0) { this.invalid = true; continue }
      for (const [channel, text] of [['reasoning', choice.delta?.reasoning_content], ['content', choice.delta?.content]] as const) {
        if (text === undefined || text === null || text.length === 0) continue
        const bytes = Buffer.from(text)
        const previous = this.segments.at(-1)
        if (previous?.channel === channel) previous.chunks.push(bytes)
        else this.segments.push({ channel, chunks: [bytes] })
      }
      for (const value of choice.logprobs?.content ?? []) {
        const top = value.top_logprobs
        this.tokens.push({ bytes: Buffer.from(value.bytes ?? []), probability: top === undefined || top.length === 0
          ? undefined : Math.exp(Math.max(...top.map(item => item.logprob))) })
      }
    }
  }

  /**
   * Attribute each token only to the next unconsumed visible bytes, preserving channel and hidden-token gaps.
   * @param policy - explicit absolute p_max and contiguous-run limits, including short channel tails.
   * @returns candidates plus independent coverage facts; no native argument coverage is inferred.
   */
  finish(policy: DetectionPolicy): Observation {
    const segments = this.segments.map(segment => ({ channel: segment.channel, bytes: Buffer.concat(segment.chunks) }))
    const result: Observation = { candidates: [], visibleTokens: 0, unattributedTokens: 0, missingTokens: 0,
      unmatchedBytes: 0, overflowed: this.overflowed, complete: false,
      content: segments.filter(segment => segment.channel === 'content').map(segment => segment.bytes.toString('utf8')).join('') }
    let index = 0
    let offset = 0
    let run: Buffer[] = []
    let channel: Candidate['channel'] = 'content'
    const close = (tail: boolean) => {
      if (run.length >= policy.minRunTokens || (tail && run.length >= policy.minTailTokens)) {
        result.candidates.push({ channel, text: Buffer.concat(run).toString('utf8'), tokens: run.length })
      }
      run = []
    }
    for (const token of this.tokens) {
      while (segments[index]?.bytes.length === offset) {
        close(true)
        index += 1
        offset = 0
      }
      const segment = segments[index]
      if (segment === undefined || token.bytes.length === 0
        || !segment.bytes.subarray(offset, offset + token.bytes.length).equals(token.bytes)) {
        close(false)
        result.unattributedTokens += 1
        continue
      }
      channel = segment.channel
      offset += token.bytes.length
      result.visibleTokens += 1
      if (token.probability === undefined) { close(false); result.missingTokens += 1 }
      else if (token.probability > policy.probabilityThreshold) run.push(token.bytes)
      else close(false)
    }
    close(true)
    result.unmatchedBytes = segments.slice(index).reduce((sum, segment, position) =>
      sum + segment.bytes.length - (position === 0 ? offset : 0), 0)
    result.complete = !this.invalid && !this.overflowed && result.visibleTokens > 0
      && result.missingTokens === 0 && result.unmatchedBytes === 0
    return result
  }
}
