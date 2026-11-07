/** Informational plugin records never authorize replayed tool execution. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

/** A live-response decision; only allow releases its own call IDs. */
export type Verdict = 'allow' | 'confirmed' | 'inconclusive' | 'unobserved' | 'observe' | 'collision'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Complete auxiliary input recorded before dispatch, without transport cancellation or credentials. */
    'plugin:probability-guard/check': {
      request: Record<string, unknown>
      candidate: number
    }
    /** Result of exactly one task flip; absence does not mean negative. */
    'plugin:probability-guard/check-result': {
      requestSeq: SessionSeq
      verdict: 'confirmed' | 'negative' | 'inconclusive'
    }
    /** Coverage and timing of one response; native tool argument probabilities are never claimed. */
    'plugin:probability-guard/response': {
      callIds: ToolCallId[]
      verdict: Verdict
      candidates: number
      checks: number
      durationMs: number
      visibleTokens: number
      unattributedTokens: number
      missingTokens: number
      unmatchedBytes: number
      complete: boolean
    }
  }
}
