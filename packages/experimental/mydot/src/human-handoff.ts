/** Durable human responses and original-Session continuation, owned by MyDot. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import { humanAnswerSchema, humanRequestIdSchema, humanRequestProjection, humanRequestSchema, humanSurveyTargetSchema, surveyResultSchema } from './human-handoff-state.ts'
import { HumanHandoffListener, readHandoffJson } from './human-handoff-transport.ts'
import type { HumanHandoffListenerConfig } from './human-handoff-transport.ts'
import type { HumanAnswer, HumanRequestId, HumanRequestView, HumanSurveyTarget, PreparedHumanRequest, SurveyHandoffResult } from './types.ts'

/** Optional local integration; no timeout is invented for a disabled feature. */
export interface HumanHandoffConfig {
  /** Enable preparation and the owner pending list; durable decoding remains registered when off. */
  humanHandoffEnabled: boolean
  /** Absolute owner-only Unix socket in an existing canonical private directory; empty disables ingress. */
  humanHandoffSocketPath: string
  /** Fixed loopback HTTP origin used to read authoritative drawing results; no model-selected destination. */
  humanHandoffSurveyOrigin: string
  /** Measured positive callback/verification deadline in milliseconds; required only for the optional socket. */
  humanHandoffTimeoutMs?: number
  /** Existing complete UTF-8 request/result byte allowance. */
  maxTextBytes: number
}
/** Model preparation fields; Session ownership and goal state come from the Host. */
export interface PrepareHumanInput {
  requestId: string
  question: string
  reason: string
  evidenceUrl: string
  resumeInstruction: string
  options: string[]
  target: HumanSurveyTarget | null
}
declare module '@deepseek-ai/cordis' {
  interface Context { mydotHandoff: HumanHandoffService }
  interface Events {
    /** Committed request state changed. @mode emit */
    'mydot/handoff-changed'(): void
  }
}

/** Concrete answer/recovery methods backed by the existing parent Session writer. */
export class HumanHandoffService extends TypertRemoteService {
  static inject = ['sessions', 'sessionQuery', 'sessionController', 'sessionProjections', 'agents', 'subagents', 'tools']
  private readonly owners = new Map<HumanRequestId, SessionId>()
  private readonly ordered = new Map<SessionId, Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private readonly ready: PromiseLike<unknown>

  constructor(ctx: Context, private readonly config: HumanHandoffConfig) {
    super(ctx, 'mydotHandoff')
    const callback = config.humanHandoffSocketPath !== ''
    let listenerConfig: HumanHandoffListenerConfig | undefined
    if (callback) {
      const origin = new URL(config.humanHandoffSurveyOrigin)
      const timeoutMs = config.humanHandoffTimeoutMs
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.protocol !== 'http:' ||
        origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        timeoutMs === undefined || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
        // Node setTimeout clamps values above this platform maximum to 1 ms (nodejs.org/api/timers.html).
        timeoutMs > 2_147_483_647) {
        throw new Error('Human handoff requires a fixed loopback HTTP origin and an explicit positive humanHandoffTimeoutMs')
      }
      if (!config.humanHandoffEnabled) throw new Error('Enable human handoff before configuring its callback')
      listenerConfig = { humanHandoffSocketPath: config.humanHandoffSocketPath, humanHandoffTimeoutMs: timeoutMs,
        maxTextBytes: config.maxTextBytes }
    }
    ctx.sessionProjections.register(humanRequestProjection)
    this.ready = ctx.effect(async () => {
      const listener = listenerConfig === undefined ? undefined : new HumanHandoffListener(listenerConfig,
        async (requestId, requestRevision, result) => {
          await this.verifySurvey(result)
          return this.accept(humanAnswerSchema.parse({ requestId, requestRevision,
            submissionId: `${requestId}:${result.survey.revisionId}:${result.planning?.revisionId ?? ''}`,
            choice: result.status === 'deferred' || result.status === 'needs-material' ? result.status : 'confirmed', text: '', result }), true)
        })
      await listener?.listen()
      try {
        for (const view of config.humanHandoffEnabled ? await this.collect() : []) {
          if (view.phase === 'received') await this.resume(view.request.requestId)
          else if (['dispatching', 'queued', 'claimed'].includes(view.phase)) await this.checkAdmission(view)
          else if (view.phase === 'pending' && view.request.target !== null && callback) {
            try { await this.recoverSurvey(view, view.request.target) }
            catch (error: unknown) { ctx.logger.warn(`MyDot human request remains pending: ${String(error)}`) }
          }
        }
      } catch (error: unknown) {
        await listener?.close()
        throw error
      }
      return async () => {
        this.lifetime.abort()
        await listener?.close()
        await Promise.allSettled([...this.ordered.values()])
      }
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (message.source.kind !== 'user' || !('rpcId' in message.source)) return
      this.observeAdmission(agent, message.source.rpcId, 'claimed')
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source) {
        const agent = ctx.agents.get(session.id)
        if (agent !== undefined) this.observeAdmission(agent, event.data.source.rpcId, 'resumed')
      }
    })
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      await this.ready
      let decision = await next()
      if (decision.kind === 'reject') return decision
      const requests = this.currentFor(agent.id).map(item => item.view)
      const waiting = requests.filter(view => view.phase === 'pending' || view.phase === 'stopped')
      if (waiting.length > 0) {
        const explicitOwnerInput = messages.some((message) => {
          const source = message.source
          return source.kind === 'user' && !('principal' in source)
            && !('rpcId' in source && typeof source.rpcId === 'string' && source.rpcId.startsWith('handoff:'))
        })
        if (!explicitOwnerInput) return { kind: 'reject' }
        for (const view of waiting) await this.retire(view.request.requestId, 'Superseded by new explicit owner input; the old answer was not replayed')
      }
      const retired = new Set(this.currentFor(agent.id).filter(({ view }) => ['retired', 'resumed', 'outcome'].includes(view.phase))
        .flatMap(({ view }) => view.rpcId === undefined ? [] : [view.rpcId]))
      const allowed = (message: Message): boolean => message.source.kind !== 'user' ||
        !('rpcId' in message.source) || !retired.has(message.source.rpcId)
      const admitted = messages.filter(allowed)
      if (admitted.length !== messages.length) {
        if (admitted.length === 0) return { kind: 'reject' }
        decision = { ...decision, messages: decision.messages.filter(allowed) }
      }
      for (const view of requests) {
        if (view.request.goal === null || view.rpcId === undefined || !admitted.some(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === view.rpcId)) continue
        const goal = this.ctx.get('goals')?.get(agent)
        if (goal === undefined || goal.id !== view.request.goal.id || goal.revision !== view.request.goal.revision ||
          goal.phase !== 'active' || goal.roundsStarted < view.request.goal.roundsStarted || goal.roundsStarted >= goal.maxGoalRounds) {
          const owner = await this.owner(view.request.requestId)
          owner.session.append('mydot/human-handoff', { kind: 'stopped', requestId: view.request.requestId, reason: 'Goal no longer permits the submitted continuation' })
          await this.flush(owner.session); this.changed(); return { kind: 'reject' }
        }
      }
      return decision
    }, { prepend: true })
    if (config.humanHandoffEnabled) this.registerTools()
  }

  /** Prepare one human dependency and disarm only its original branch.
   * @param agent - Actual initiating branch, never a model-selected Session.
   * @param input - Versioned question and evidence prepared for the owner.
   * @returns Persisted pending request.
   */
  async prepare(agent: Agent, input: PrepareHumanInput): Promise<HumanRequestView> {
    await this.ready
    if (!this.config.humanHandoffEnabled) throw new Error('Human handoff is disabled')
    const parent = this.ctx.agents.list().find(candidate => this.ctx.agents.isOwnedBy(agent.id, candidate))
    if (parent !== undefined && this.ctx.agents.list().some(candidate => this.ctx.agents.isOwnedBy(parent.id, candidate))) {
      throw new Error('Nested human handoff is unavailable; prepare the request on the owning root or its direct child')
    }
    if (parent !== undefined && agent.options.maxTokens !== undefined) throw new Error('This child has a per-activation token cap that cold resume cannot preserve; prepare on the root Session')
    const owner = parent ?? agent
    return this.serialize(owner.id, async () => {
      const goals = this.ctx.get('goals')
      const goal = goals?.get(agent)
      const request = humanRequestSchema.parse({ ...input, requestRevision: 1, sessionId: agent.id, parentSessionId: parent?.id ?? null,
        role: 'owner', goal: goal === undefined ? null : { id: goal.id, revision: goal.revision, roundsStarted: goal.roundsStarted, armed: goal.activation === 'armed' } })
      if (parent !== undefined) await this.flush(agent.session)
      if (this.owners.has(request.requestId) && this.owners.get(request.requestId) !== owner.id) throw new Error('Request identity belongs to another original Session')
      if (request.target !== null) {
        if (request.evidenceUrl === '') throw new Error('A survey request needs its private source link')
        if (request.target.workflow === 'independent-reference' && request.options.length !== 0) throw new Error('Independent reference must not expose model options')
        const url = new URL(request.evidenceUrl)
        if (url.searchParams.has('case') && url.searchParams.get('case') !== request.target.caseId) throw new Error('The first handoff path requires the same survey and planning case')
        for (const [key, value] of Object.entries({ requestId: request.requestId, requestRevision: String(request.requestRevision),
          caseId: request.target.caseId, case: request.target.caseId, source: request.target.sourceId,
          sourceRevision: request.target.sourceRevision, baseRevisionId: request.target.baseRevisionId,
          baseVersion: String(request.target.baseVersion), workflow: request.target.workflow })) url.searchParams.set(key, value)
        request.evidenceUrl = url.href
      }
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > this.config.maxTextBytes) throw new Error('Prepared request exceeds the configured byte allowance')
      const existing = this.views(owner.session).find(view => view.request.requestId === request.requestId)
      if (existing !== undefined) {
        if (JSON.stringify({ ...existing.request, goal: null }) !== JSON.stringify({ ...request, goal: null })) throw new Error('Request identity was reused with different input')
        await this.flush(owner.session)
        return existing
      }
      if (this.currentFor(agent.id).some(({ view }) => view.phase === 'pending')) throw new Error('Answer the existing request before preparing another')
      owner.session.append('mydot/human-handoff', { kind: 'prepared', request })
      this.owners.set(request.requestId, owner.id)
      goals?.disarm(agent)
      await this.flush(owner.session)
      this.changed()
      return this.view(owner.session, request.requestId)
    })
  }

  /** Accept an owner response; a receipt does not certify subsequent work.
   * @param input - Stable submission and exact observed request revision.
   * @returns Current durable receipt or correlated execution state.
   */
  @Remote
  async answer(input: HumanAnswer): Promise<HumanRequestView> {
    await this.ready
    if (principalOf(this.ctx.invocation) !== undefined) throw new Error('Only the authenticated Host owner may answer this request')
    return this.accept(humanAnswerSchema.parse(input), false)
  }

  /** Reconcile a saved external result or an accepted but undelivered answer.
   * @param requestId - Exact durable request identity.
   * @returns Saved state, including explicit refusal or uncertainty.
   */
  @Remote
  async reconcile(requestId: HumanRequestId): Promise<HumanRequestView> {
    await this.ready
    if (principalOf(this.ctx.invocation) !== undefined) throw new Error('Only the authenticated Host owner may recover this request')
    await this.collect()
    const owner = await this.owner(requestId)
    const view = this.view(owner.session, requestId)
    if (view.phase === 'pending' && view.request.target !== null) return this.recoverSurvey(view, view.request.target)
    if (['dispatching', 'queued', 'claimed'].includes(view.phase)) await this.checkAdmission(view)
    if (view.phase === 'stopped' && view.rpcId === undefined && view.answer !== undefined && !['unknown', 'needs-material', 'deferred', 'rejected'].includes(view.answer.choice)) {
      owner.session.append('mydot/human-handoff', { kind: 'received', requestId, answer: view.answer, responder: 'host-owner' })
      await this.flush(owner.session)
      await this.resume(requestId)
    }
    if (view.phase === 'received') await this.resume(requestId)
    return this.view(owner.session, requestId)
  }

  /** Retire a dependency without replaying or changing its saved answer.
   * @param requestId - Exact request the owner is cancelling.
   * @returns Durable retired state; no external action or model turn is started.
   */
  @Remote
  async cancel(requestId: HumanRequestId): Promise<HumanRequestView> {
    await this.ready
    if (principalOf(this.ctx.invocation) !== undefined) throw new Error('Only the authenticated Host owner may cancel this request')
    const owner = await this.owner(requestId)
    return this.serialize(owner.id, async () => {
      const view = this.view(owner.session, requestId)
      if (!['pending', 'stopped', 'retired', 'outcome'].includes(view.phase)) {
        throw new Error('Continuation was already dispatched; open the original Session to inspect and stop it')
      }
      return this.retire(requestId, 'Cancelled by the owner; no old answer will be replayed')
    })
  }

  /** Read the canonical projected request list without holding a model or a browser.
   * @returns Current request states reconstructed from Session projections.
   */
  async snapshot(): Promise<readonly HumanRequestView[]> { await this.ready; return this.config.humanHandoffEnabled ? this.collect() : [] }

  private async collect(): Promise<HumanRequestView[]> {
    const views: HumanRequestView[] = []
    for (const record of await this.ctx.sessionQuery.listSessions(this.lifetime.signal)) {
      using source = await this.ctx.sessionQuery.observeSession(record.header.id)
      for (const view of source.projections?.values.mydotHumanRequests ?? []) {
        if (view.request.parentSessionId !== null && view.request.parentSessionId !== record.header.id) continue
        if (view.request.parentSessionId === null && view.request.sessionId !== record.header.id) continue
        const knownOwner = this.owners.get(view.request.requestId)
        if (knownOwner !== undefined && knownOwner !== record.header.id) throw new Error('Persisted human request identity belongs to multiple Sessions')
        this.owners.set(view.request.requestId, record.header.id)
        views.push(view)
      }
    }
    return views
  }
  private async retire(id: HumanRequestId, reason: string): Promise<HumanRequestView> {
    const owner = await this.owner(id)
    const view = this.view(owner.session, id)
    if (view.phase === 'retired' || view.phase === 'outcome') return view
    owner.session.append('mydot/human-handoff', { kind: 'retired', requestId: id, reason })
    await this.flush(owner.session); this.changed()
    return this.view(owner.session, id)
  }
  private views(session: Session): readonly HumanRequestView[] { return this.ctx.sessionProjections.stateOf(session, 'mydotHumanRequests') ?? [] }
  private view(session: Session, id: HumanRequestId): HumanRequestView {
    const found = this.views(session).find(view => view.request.requestId === id)
    if (found === undefined) throw new Error('Human request not found')
    return found
  }
  private currentFor(sessionId: SessionId): { view: HumanRequestView; owner: Session }[] {
    return [...this.owners].flatMap(([id, ownerId]) => {
      const owner = this.ctx.sessions.get(ownerId)
      if (owner === undefined) return []
      const view = this.views(owner).find(item => item.request.requestId === id && item.request.sessionId === sessionId)
      return view === undefined ? [] : [{ view, owner }]
    })
  }
  private async owner(id: HumanRequestId): Promise<Agent> {
    const ownerId = this.owners.get(id)
    if (ownerId === undefined) throw new Error('Human request not found')
    const live = this.ctx.agents.get(ownerId)
    if (live !== undefined) return live
    const resolved = await this.ctx.sessionController.resolveAgent(ownerId)
    if ('error' in resolved) throw resolved.error
    return resolved.agent
  }
  private async flush(session: Session): Promise<void> {
    if (!(await this.ctx.sessions.flush(session))) throw new Error('Human handoff requires durable Session persistence')
  }
  private async accept(answer: HumanAnswer, verified: boolean): Promise<HumanRequestView> {
    if (Buffer.byteLength(JSON.stringify(answer), 'utf8') > this.config.maxTextBytes) {
      throw new Error('Human answer exceeds the configured byte allowance')
    }
    if (this.owners.size === 0) await this.collect()
    const owner = await this.owner(answer.requestId)
    const accepted = await this.serialize(owner.id, async () => {
      const view = this.view(owner.session, answer.requestId)
      if (view.request.requestRevision !== answer.requestRevision) throw new Error('Human request revision changed')
      if (view.answer !== undefined) {
        if (JSON.stringify(view.answer) !== JSON.stringify(answer)) throw new Error('Submission identity was reused with different input')
        await this.flush(owner.session)
        return view
      }
      if (view.phase !== 'pending') throw new Error('Human request is no longer pending')
      if (!['confirmed', 'unknown', 'needs-material', 'deferred', 'rejected', ...view.request.options].includes(answer.choice)) throw new Error('Select a prepared answer or provide an explicit disposition')
      if (view.request.target !== null) {
        if (answer.result === null && !['unknown', 'needs-material', 'deferred', 'rejected'].includes(answer.choice)) throw new Error('Save a result for the exact source version before answering')
        if (answer.result !== null) {
          if (!verified) await this.verifySurvey(answer.result)
          this.matchTarget(view.request, answer.result)
          if (['deferred', 'needs-material'].includes(answer.result.status) &&
            !['unknown', 'needs-material', 'deferred', 'rejected'].includes(answer.choice)) {
            throw new Error('The saved result disposition does not permit confirmation or continuation')
          }
        }
      } else if (answer.result !== null) throw new Error('This request has no survey target')
      owner.session.append('mydot/human-handoff', { kind: 'received', requestId: answer.requestId, answer, responder: 'host-owner' })
      try { await this.flush(owner.session) }
      catch (error: unknown) {
        owner.session.append('mydot/human-handoff', { kind: 'stopped', requestId: answer.requestId, reason: 'Answer persistence is unconfirmed; no continuation was sent' })
        throw error
      }
      this.changed()
      return this.view(owner.session, answer.requestId)
    })
    if (accepted.phase === 'received') await this.resume(answer.requestId)
    return this.view(owner.session, answer.requestId)
  }
  private async resume(id: HumanRequestId): Promise<void> {
    const owner = await this.owner(id)
    await this.serialize(owner.id, async () => {
      const view = this.view(owner.session, id)
      if (view.phase !== 'received' || view.answer === undefined) return
      const stop = async (reason: string): Promise<void> => {
        owner.session.append('mydot/human-handoff', { kind: 'stopped', requestId: id, reason })
        await this.flush(owner.session); this.changed()
      }
      if (['unknown', 'needs-material', 'deferred', 'rejected'].includes(view.answer.choice)) {
        await stop(`Owner response: ${view.answer.choice}. The answer grants no new action authority.`); return
      }
      if (view.answer.result !== null) {
        try { await this.verifySurvey(view.answer.result) }
        catch (error: unknown) { await stop(`Saved result cannot be verified for continuation: ${String(error)}`); return }
      }
      const current = this.ctx.agents.get(view.request.sessionId)
      const goals = this.ctx.get('goals')
      if (current !== undefined && view.request.goal === null && goals?.get(current) !== undefined) {
        await stop('A goal was created after this request; use new owner input to select the current work'); return
      }
      if (current === undefined && view.request.goal !== null) {
        using source = await this.ctx.sessionQuery.observeSession(view.request.sessionId)
        const projected = source.projections?.values.goal
        if (projected === undefined || projected === null || projected.goal.id !== view.request.goal.id ||
          projected.goal.revision !== view.request.goal.revision ||
          projected.goal.phase !== 'active' || projected.roundsStarted < view.request.goal.roundsStarted ||
          projected.roundsStarted >= projected.goal.maxGoalRounds) {
          await stop('The saved goal changed, paused, completed or exhausted; continuation was not authorized'); return
        }
      }
      if (current !== undefined && view.request.goal !== null) {
        const goal = goals?.get(current)
        if (goal === undefined || goal.id !== view.request.goal.id || goal.revision !== view.request.goal.revision ||
          goal.phase !== 'active' || goal.roundsStarted < view.request.goal.roundsStarted ||
          goal.roundsStarted >= goal.maxGoalRounds) { await stop('Goal changed, paused, completed or exhausted; continuation was not authorized'); return }
      }
      const rpcId = `handoff:${id}:${view.request.requestRevision}`
      owner.session.append('mydot/human-handoff', { kind: 'dispatching', requestId: id, rpcId })
      await this.flush(owner.session)
      const text = 'Human response to the prepared request. Use only the referenced version; this response grants no broader external-action permission. '
        + JSON.stringify({ requestId: id, question: view.request.question, answer: view.answer, next: view.request.resumeInstruction })
      try {
        if (view.request.parentSessionId !== null) {
          await this.ctx.subagents.prompt({ parentSessionId: owner.id, childSessionId: view.request.sessionId,
            requestId: rpcId as SubagentPromptRequestId,
            mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text }] }, this.lifetime.signal)
        } else {
          owner.followup(createUserMessage({ source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] }))
        }
        owner.session.append('mydot/human-handoff', { kind: 'queued', requestId: id })
        await this.flush(owner.session)
      } catch (error: unknown) { await stop(`Delivery outcome is unknown; do not replay automatically: ${String(error)}`) }
      this.changed()
    })
  }
  private observeAdmission(agent: Agent, rpcId: string, kind: 'claimed' | 'resumed'): void {
    for (const { view, owner } of this.currentFor(agent.id)) {
      if (view.rpcId !== rpcId) continue
      if (view.phase === 'retired' || view.phase === 'outcome') continue
      if (kind === 'resumed' && owner.id === agent.id) { this.changed(); continue }
      owner.append('mydot/human-handoff', { kind, requestId: view.request.requestId })
      this.changed()
    }
  }
  private async checkAdmission(view: HumanRequestView): Promise<void> {
    const owner = await this.owner(view.request.requestId)
    using source = await this.ctx.sessionQuery.observeSession(view.request.sessionId)
    const admitted = source.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' &&
      'rpcId' in event.data.source && event.data.source.rpcId === view.rpcId)
    if (admitted) owner.session.append('mydot/human-handoff', { kind: 'resumed', requestId: view.request.requestId })
    else if (this.ctx.agents.get(view.request.sessionId) === undefined) owner.session.append('mydot/human-handoff', { kind: 'stopped', requestId: view.request.requestId,
      reason: 'Continuation admission is unconfirmed after restart; inspect the original Session before authorizing new work. The saved answer has not been replayed.' })
    await this.flush(owner.session); this.changed()
  }
  private matchTarget(request: PreparedHumanRequest, result: SurveyHandoffResult): void {
    const target = request.target
    if (target === null || result.requestId !== request.requestId || target.caseId !== result.source.caseId ||
      target.sourceId !== result.source.sourceId || target.sourceRevision !== result.source.sourceRevision ||
      target.baseRevisionId !== result.baseSurvey.revisionId || target.baseVersion !== result.baseSurvey.version) {
      throw new Error('Survey result does not match the original source and base revision')
    }
    if (result.planning !== null && result.planning.caseId !== target.caseId) throw new Error('Saved planning result belongs to another case')
  }
  private async verifySurvey(result: SurveyHandoffResult): Promise<SurveyHandoffResult> {
    const saved = await this.readSavedSurvey(result.requestId, result.source)
    if (JSON.stringify(saved) !== JSON.stringify(result)) throw new Error('The authoritative survey result changed')
    return saved
  }
  private async readSavedSurvey(requestId: HumanRequestId, source: { caseId: string; sourceId: string }): Promise<SurveyHandoffResult> {
    if (!this.config.humanHandoffSocketPath || this.config.humanHandoffTimeoutMs === undefined) throw new Error('Survey callback verification is not configured')
    const path = `/api/survey/${encodeURIComponent(source.caseId)}/${encodeURIComponent(source.sourceId)}/handoffs/${encodeURIComponent(requestId)}`
    const response = await fetch(new URL(path, this.config.humanHandoffSurveyOrigin), {
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.humanHandoffTimeoutMs)]), redirect: 'error',
    })
    if (!response.ok || response.body === null) throw new Error('The saved survey result is unavailable')
    const raw = await readHandoffJson(response.body, this.config.maxTextBytes)
    const parsed = z.object({ result: surveyResultSchema,
      current: z.object({ survey: z.literal(true), planning: z.literal(true) }).strict() }).strict().parse(raw)
    return parsed.result
  }
  private async recoverSurvey(view: HumanRequestView, target: HumanSurveyTarget): Promise<HumanRequestView> {
    const result = await this.readSavedSurvey(view.request.requestId, target)
    return this.accept(humanAnswerSchema.parse({ requestId: view.request.requestId, requestRevision: view.request.requestRevision,
      submissionId: `${view.request.requestId}:${result.survey.revisionId}:${result.planning?.revisionId ?? ''}`,
      choice: result.status === 'deferred' || result.status === 'needs-material' ? result.status : 'confirmed', text: '', result }), true)
  }
  private serialize<T>(id: SessionId, work: () => Promise<T>): Promise<T> {
    const previous = this.ordered.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.ordered.set(id, next)
    void next.finally(() => { if (this.ordered.get(id) === next) this.ordered.delete(id) }).catch(() => undefined)
    return next
  }
  private changed(): void { this.ctx.emit('mydot/handoff-changed') }
  private registerTools(): void {
    this.ctx.tools.register(defineTool({
      name: 'prepare_human_request', description: 'Prepare a versioned owner decision, information request or original-source review. End only this branch while independent work continues. Do not use for work you can repair yourself.',
      parameters: { request_id: { type: 'string', required: true }, question: { type: 'string', required: true }, reason: { type: 'string', required: true },
        evidence_url: { type: 'string', required: true }, resume_instruction: { type: 'string', required: true },
        options: { type: 'array', items: { type: 'string' }, required: true }, target: { type: 'json' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { requestId: { type: 'string', required: true }, state: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        if (exec.agent === undefined) throw new Error('A human request requires its initiating Session')
        const request = await this.prepare(exec.agent, { requestId: args.request_id, question: args.question, reason: args.reason,
          evidenceUrl: args.evidence_url, resumeInstruction: args.resume_instruction, options: args.options,
          target: args.target === undefined ? null : humanSurveyTargetSchema.nullable().parse(args.target) })
        exec.concludeTurn()
        return { requestId: request.request.requestId, state: 'pending' }
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'record_human_request_outcome', description: 'Record the result or a concrete stopping reason after a human response was consumed. Successful work requires an existing result artifact; an inbox receipt or inactivity is not success.',
      parameters: { request_id: { type: 'string', required: true }, outcome: { type: 'string', enum: ['succeeded', 'failed', 'unknown'], required: true }, evidence: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { requestId: { type: 'string', required: true }, outcome: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        if (exec.agent === undefined) throw new Error('Outcome requires the original Session')
        const id = humanRequestIdSchema.parse(args.request_id)
        const owner = await this.owner(id)
        const view = this.view(owner.session, id)
        if (view.request.sessionId !== exec.agent.id || view.phase !== 'resumed') throw new Error('Record an outcome only after this exact original Session consumed its answer')
        if (args.evidence.trim() === '') throw new Error('An outcome requires evidence or a concrete stopping reason')
        if (args.outcome === 'succeeded') {
          const cwd = exec.agent.session.header.cwd
          const file = await this.ctx.get('fs')?.resolve(args.evidence, cwd === undefined ? {} : { cwd })
          if (file === undefined || (await this.ctx.get('fs')?.stat(file))?.type !== 'file') throw new Error('Successful outcome requires an existing result artifact')
        }
        owner.session.append('mydot/human-handoff', { kind: 'outcome', requestId: id, outcome: args.outcome, evidence: args.evidence })
        await this.flush(owner.session); this.changed()
        return { requestId: id, outcome: args.outcome }
      },
    }))
  }
}
