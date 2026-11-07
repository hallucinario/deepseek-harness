/** Opt-in visible-token probability guard using pi-ai middleware and the final tool guard. */
import { addAbortListener } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolCallBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-pi-ai'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { ProbabilitySeries } from './detector.ts'
import type { DetectionPolicy, Candidate } from './detector.ts'
import { classifyConfirmation, confirmationRequest } from './confirmation.ts'
import type { Verdict } from './types.ts'

/** Every policy value is deployment-owned; mounting does not imply calibration or adoption. */
export interface Config extends DetectionPolicy {
  /** Observe records coverage without confirmation/denial; enforce enables confirmation and blocking. */
  mode: 'observe' | 'enforce'
  /** Original configured provider route names protected by this instance. */
  providers: string[]
  /** Total raw provider-event bytes retained per inference. */
  maxObservationBytes: number
  /** Maximum individually checked candidates per response; overflow holds execution. */
  maxChecks: number
  /** Minimum exact execution string length eligible for a confirmed repeat. */
  minExecutionChars: number
  /** Output cap includes the confirmation inference reasoning budget. */
  confirmationMaxTokens: number
  /** Total wall-clock confirmation deadline, including Session flush. */
  confirmationTimeoutMs: number
  /** Explicit choice for incomplete visible coverage; allow never means inspected native arguments. */
  missingObservation: 'hold' | 'allow-unobserved'
  /** Explicit top-level string arguments naming execution content; no automatic command/path inference. */
  executionFields: {
    /** Exact model-visible tool name. */
    tool: string
    /** Top-level string argument containing the execution text. */
    field: string
  }[]
}

const positiveInteger = () => z.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).required()
/** Explicit opt-in deployment policy, with no probability or run-length defaults. */
export const Config: z<Config> = z.object({
  mode: z.union(['observe', 'enforce']).required(), providers: z.array(z.string().required()).min(1).required(),
  probabilityThreshold: z.number().min(0).max(1).required(), minRunTokens: positiveInteger(), minTailTokens: positiveInteger(),
  maxObservationBytes: positiveInteger(), maxChecks: positiveInteger(), minExecutionChars: positiveInteger(),
  confirmationMaxTokens: positiveInteger(), confirmationTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).step(1).required(),
  missingObservation: z.union(['hold', 'allow-unobserved']).required(),
  executionFields: z.array(z.object({ tool: z.string().required(), field: z.string().required() })).min(1).required(),
})
export const name = 'experimental-probability-guard'
export const inject = ['llm', 'tools', 'agents', 'sessions']

interface CallDecision { request: GenerateOptions; verdict: Verdict }

/**
 * Register reversible provider observation and final execution checks.
 * @param ctx - owning plugin context, including the real tool executor and live agents.
 * @param config - explicit deployment policy.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.minTailTokens > config.minRunTokens || config.probabilityThreshold >= 1) {
    throw new Error('probability-guard: minTailTokens must not exceed minRunTokens and probabilityThreshold must be less than 1')
  }
  const active = new WeakMap<GenerateOptions, ProbabilitySeries>()
  const confirmations = new WeakMap<AbortSignal, ProbabilitySeries>()
  const decisions = new Map<SessionId, Map<ToolCallId, CallDecision>>()
  const stopping = new AbortController()
  ctx.effect(() => () => { stopping.abort('probability guard unloaded'); decisions.clear() })
  ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') decisions.delete(session.id) })
  ctx.on('agent/disposed', ({ agent }) => { decisions.delete(agent.id) })
  ctx.on('llm-pi-ai/provider-event', (request, data) => {
    const series = active.get(request) ?? (request.signal === undefined ? undefined : confirmations.get(request.signal))
    series?.observe(data)
  })
  ctx.tools.guard((exec) => {
    if (config.mode !== 'enforce' || exec.agent === undefined) return undefined
    const owned = decisions.get(exec.agent.id)
    if (owned === undefined && !config.providers.includes(exec.agent.options.provider ?? '')) return undefined
    const decision = owned?.get(exec.rootCallId)
    if (decision?.verdict === 'allow') return undefined
    const reason = 'probability-guard: tool execution held (' + (decision?.verdict ?? 'no matching response observation') + ').'
    exec.agent.cancel({ kind: 'hook', reason })
    return reason
  })
  ctx.on('llm-pi-ai/stream', (request, next) => intercept(request, next))

  async function confirm(
    agent: Agent, request: GenerateOptions, candidate: Candidate, index: number, executions: string[],
  ): Promise<'confirmed' | 'negative' | 'inconclusive'> {
    const owner = new AbortController()
    const parents = [stopping.signal, owner.signal, ...request.signal === undefined ? [] : [request.signal]]
    using timeout = deadline(AbortSignal.any(parents), config.confirmationTimeoutMs, 'PROBABILITY_CONFIRMATION_TIMEOUT')
    const check = confirmationRequest(request, config.confirmationMaxTokens, timeout.signal)
    const series = new ProbabilitySeries(config.maxObservationBytes)
    confirmations.set(timeout.signal, series)
    const { signal: _signal, ...input } = check
    const logged = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
    const seq = appendPluginRecord(agent.session, 'plugin:probability-guard/check', { request: logged, candidate: index })
    const aborted = Promise.withResolvers<never>()
    using _listener = addAbortListener(timeout.signal, () => { aborted.reject(timeout.signal.reason) })
    let verdict: 'confirmed' | 'negative' | 'inconclusive' = 'inconclusive'
    let iterator: AsyncIterator<StreamChunk> | undefined
    try {
      timeout.signal.throwIfAborted()
      if (!await Promise.race([ctx.sessions.flush(agent.session), aborted.promise])) {
        throw new Error('probability-guard: confirmation has no Session durability participant')
      }
      iterator = ctx.llm.stream(check)[Symbol.asyncIterator]()
      const assembler = new BlockAssembler()
      let finish: string | undefined
      while (true) {
        timeout.signal.throwIfAborted()
        const item = await Promise.race([iterator.next(), aborted.promise])
        if (item.done) break
        assembler.push(item.value)
        if (item.value.type === 'finish') finish = item.value.reason.kind
      }
      if (!assembler.blocks().some(block => block.type === 'tool-call')) {
        verdict = classifyConfirmation(
          candidate, executions, series.finish(config), finish, config.minExecutionChars,
        )
      }
    } catch (_inconclusiveConfirmation) {
      // Timeout, cancellation, transport, and durability failures hold this execution.
      verdict = 'inconclusive'
    } finally {
      owner.abort('confirmation settled')
      confirmations.delete(timeout.signal)
      if (iterator?.return !== undefined) {
        void iterator.return().catch((_cleanupFailure: unknown) => { /* Adapter cancellation owns the abandoned read. */ })
      }
    }
    appendPluginRecord(agent.session, 'plugin:probability-guard/check-result', { requestSeq: seq, verdict })
    return verdict
  }

  async function* intercept(request: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (!config.providers.includes(request.provider) || (request.signal !== undefined && confirmations.has(request.signal))) {
      yield* next()
      return
    }
    const agent = request.sessionId === undefined ? undefined : ctx.agents.get(request.sessionId)
    if (agent === undefined) { yield* next(); return }
    const series = new ProbabilitySeries(config.maxObservationBytes)
    const assembler = new BlockAssembler()
    const calls = new Map<ToolCallId, CallDecision>()
    let owned = decisions.get(agent.id)
    if (owned === undefined) { owned = new Map(); decisions.set(agent.id, owned) }
    let collision = false
    let checks = 0
    const started = performance.now()
    active.set(request, series)
    try {
      let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
      let sourceFailed = false
      try {
        for await (const chunk of next()) {
          assembler.push(chunk)
          const id = chunk.type === 'tool-call-delta' ? chunk.id : chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? chunk.block.id : undefined
          if (id !== undefined && !calls.has(id)) {
            const previous = owned.get(id)
            const decision: CallDecision = { request, verdict: 'inconclusive' }
            if (previous !== undefined) { previous.verdict = 'collision'; decision.verdict = 'collision'; collision = true }
            else owned.set(id, decision)
            calls.set(id, decision)
          }
          if (chunk.type === 'finish') finish = chunk
          else yield chunk
        }
      } catch (error) {
        sourceFailed = true
        finish = { type: 'finish', reason: { kind: 'error', failure: { code: 'PROBABILITY_SOURCE_FAILED', message: error instanceof Error ? error.message : String(error) } } }
      }
      const observed = series.finish(config)
      let verdict: Verdict = config.mode === 'observe' ? 'observe' : collision ? 'collision' : 'allow'
      const tools = assembler.blocks().filter((block): block is ToolCallBlock => block.type === 'tool-call')
      if (config.mode === 'enforce' && (tools.length > 0 || sourceFailed && observed.candidates.length > 0) && !collision) {
        if (finish === undefined || sourceFailed || finish.reason.kind !== 'tool-calls' && finish.reason.kind !== 'stop') verdict = 'inconclusive'
        else if (observed.candidates.length > config.maxChecks) verdict = 'inconclusive'
        else {
          const executions: string[] = []
          for (const tool of tools) {
            let args: unknown
            try { args = JSON.parse(tool.arguments) } catch (_invalidToolArguments) { continue }
            if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
            for (const field of config.executionFields) {
              if (field.tool !== tool.name) continue
              const value: unknown = Reflect.get(args, field.field)
              if (typeof value === 'string') executions.push(value)
            }
          }
          for (const [index, candidate] of observed.candidates.entries()) {
            checks += 1
            const result = await confirm(agent, request, candidate, index, executions)
            if (result !== 'negative') { verdict = result; break }
          }
          if (verdict === 'allow' && !observed.complete && config.missingObservation === 'hold') verdict = 'unobserved'
        }
      }
      for (const [id, decision] of calls) {
        if (owned.get(id)?.request === request && decision.verdict !== 'collision') decision.verdict = verdict
      }
      appendPluginRecord(agent.session, 'plugin:probability-guard/response', { callIds: [...calls.keys()], verdict,
        candidates: observed.candidates.length, checks, durationMs: performance.now() - started,
        visibleTokens: observed.visibleTokens, unattributedTokens: observed.unattributedTokens,
        missingTokens: observed.missingTokens, unmatchedBytes: observed.unmatchedBytes, complete: observed.complete })
      if (config.mode === 'enforce' && verdict !== 'allow') agent.cancel({ kind: 'hook', reason: 'probability-guard: ' + verdict + '; current run stopped before tool execution.' })
      if (finish !== undefined) yield finish
    } finally { active.delete(request) }
  }
}
