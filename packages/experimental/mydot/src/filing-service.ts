/** MyDot owner Remote operations backed exclusively by the original Session writer. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { type Session, type SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FilingWorkflow } from './filing.ts'
import { filingPlanSchema, filingProjection, filingViewSchema, mockReceiptSchema } from './filing-state.ts'
import { readRecorderStatus, type RecorderConnection } from './filing-recorder.ts'
import type { FilingCaseId, FilingCardView, FilingPlan, FilingView, MockReceipt } from './filing-types.ts'
/** Optional synthetic filing and independently operated recorder; no operational default deadlines. */
export interface FilingConfig {
  /** Enable synthetic plans and owner commands; no real recipient is supported. */
  filingEnabled?: boolean
  /** Fixed owner-private recorder socket; no model-selected endpoint. */
  filingRecorderSocketPath?: string
  /** Positive status request deadline, supplied from deployment evidence. */
  filingRecorderTimeoutMs?: number
  /** Maximum acceptable observation age, supplied from deployment evidence. */
  filingRecorderMaxAgeMs?: number
  /** Existing complete UTF-8 input/output allowance. */
  maxTextBytes: number
}
interface FilingServiceConfig extends FilingConfig {
  recovered(): void
  takeover(sessionId: SessionId): Promise<void>
  returnControl(): Promise<void>
  read(sessionId: SessionId, path: string): Promise<string>
}
declare module '@deepseek-ai/cordis' { interface Context { mydotFiling: FilingService } }
/** Owner authority stays in Remote methods; model tools can only prepare plans. */
export class FilingService extends TypertRemoteService {
  static inject = ['sessions', 'sessionQuery', 'sessionController', 'sessionProjections', 'tools', 'agents']
  private readonly cases = new Map<FilingCaseId, { session: Session; workflow: FilingWorkflow }>()
  private takeoverCase: FilingCaseId | undefined
  private controlOrder: Promise<unknown> = Promise.resolve()
  private closing = false
  private readonly admitted = new Set<Promise<unknown>>()
  private readonly failed = new Set<FilingCaseId>()
  private readonly loading: PromiseLike<unknown>
  private readonly recorderConnection!: RecorderConnection
  private readonly recorderMaxAgeMs!: number
  constructor(ctx: Context, private readonly config: FilingServiceConfig) {
    super(ctx, 'mydotFiling')
    if (config.filingEnabled) {
      if (!config.filingRecorderSocketPath || !isAbsolute(config.filingRecorderSocketPath)
        || !config.filingRecorderTimeoutMs || !config.filingRecorderMaxAgeMs
        || !Number.isSafeInteger(config.filingRecorderTimeoutMs) || config.filingRecorderTimeoutMs < 1
        || config.filingRecorderTimeoutMs > 2_147_483_647
        || !Number.isSafeInteger(config.filingRecorderMaxAgeMs) || config.filingRecorderMaxAgeMs < 1) {
        throw new Error('Synthetic filing requires a fixed recorder socket and explicit positive request deadline and freshness limit')
      }
      this.recorderConnection = { socketPath: config.filingRecorderSocketPath,
        timeoutMs: config.filingRecorderTimeoutMs, maxBytes: config.maxTextBytes }
      this.recorderMaxAgeMs = config.filingRecorderMaxAgeMs
    }
    const projection = ctx.sessionProjections.register(filingProjection)
    const loading = ctx.effect(async () => {
      if (!config.filingEnabled) return () => undefined
      let human: FilingView | undefined
      let returned: FilingView | undefined
      for (const record of await ctx.sessionQuery.listSessions()) {
        using source = await ctx.sessionQuery.observeSession(record.header.id)
        for (const view of source.projections?.values.mydotFilings ?? []) {
          if (view.sessionId !== record.header.id) continue
          if (view.control === 'human' || view.control === 'stopping') {
            if (this.takeoverCase !== undefined && this.takeoverCase !== view.plan.caseId) throw new Error('Multiple persisted human owners require inspection')
            this.takeoverCase = view.plan.caseId
            human = view
          } else if (view.control === 'return-authorized') returned = view
        }
      }
      if (human !== undefined) await config.takeover(human.sessionId)
      else if (returned !== undefined) { await config.takeover(returned.sessionId); await config.returnControl() }
      config.recovered()
      return () => undefined
    })
    this.loading = loading
    ctx.effect(function* (this: FilingService) {
      yield loading
      yield projection
      if (config.filingEnabled) yield this.registerTool()
      yield async () => {
        this.closing = true
        await Promise.allSettled([Promise.resolve(this.loading), ...this.admitted])
      }
    }.bind(this))
  }
  private assertOpen(): void { if (this.closing) throw new Error('Filing service is closing') }
  private admit<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const task = Promise.resolve().then(work)
    this.admitted.add(task)
    void task.then(() => { this.admitted.delete(task) }, () => { this.admitted.delete(task) })
    return task
  }
  private ownerOnly(): void {
    if (principalOf(this.ctx.invocation) !== undefined) throw new Error('Only the authenticated Host owner may decide a filing')
    if (!this.config.filingEnabled) throw new Error('Synthetic filing is disabled')
  }
  private transferControl<T>(work: () => Promise<T>): Promise<T> {
    const next = this.controlOrder.catch(() => undefined).then(work)
    this.controlOrder = next
    return next
  }
  private views(session: Session): readonly FilingView[] { return this.ctx.sessionProjections.stateOf(session, 'mydotFilings') ?? [] }
  private bind(session: Session, id: FilingCaseId): FilingWorkflow {
    const prior = this.cases.get(id)
    if (prior !== undefined) {
      if (prior.session.id !== session.id) throw new Error('Case belongs to another original Session')
      return prior.workflow
    }
    const persist = async (view: FilingView): Promise<void> => {
      this.assertOpen()
      session.append('mydot/filing', { view: filingViewSchema.parse(view) })
      try { if (!(await this.ctx.sessions.flush(session))) throw new Error('Filing requires durable Session persistence') }
      catch (error: unknown) { this.failed.add(id); throw error }
      this.ctx.emit('mydot/handoff-changed')
    }
    const workflow = new FilingWorkflow({ load: () => this.views(session).find(view => view.plan.caseId === id), persist,
      read: path => this.config.read(session.id, path), now: Date.now,
      fence: () => { this.assertOpen(); return this.config.takeover(session.id) },
      returnControl: () => { this.assertOpen(); return this.config.returnControl() }, recorderMaxAgeMs: this.recorderMaxAgeMs,
      recorder: (caseId, digest) => readRecorderStatus(this.recorderConnection, caseId, digest),
      recipient: {
        query: async (intentId) => {
          if (!(await this.ctx.sessions.flush(session))) throw new Error('Receipt durability is unconfirmed')
          return this.receipt(session, intentId)
        },
        confirm: async (intent) => {
          const known = await this.receipt(session, intent.intentId)
          if (known !== null) return known
          this.assertOpen()
          // The synthetic recipient is a narrow adapter within this Session, not a network sender.
          const receipt = mockReceiptSchema.parse({ ...intent, receiptId: `receipt-${intent.intentId}` })
          session.append('mydot/mock-receipt', receipt)
          if (!(await this.ctx.sessions.flush(session))) throw new Error('Synthetic receipt callback is unconfirmed; query by intent')
          return receipt
        },
      },
    })
    this.cases.set(id, { session, workflow }); return workflow
  }
  private async receipt(session: Session, intentId: string): Promise<MockReceipt | null> {
    using source = await this.ctx.sessionQuery.observeSession(session.id)
    for (const event of source.events) if (event.type === 'mydot/mock-receipt' && event.data.intentId === intentId) return mockReceiptSchema.parse(event.data)
    return null
  }
  private async find(id: FilingCaseId): Promise<FilingWorkflow> {
    await this.loading
    if (this.failed.has(id)) throw new Error('Filing persistence is unconfirmed; restart and query the original Session')
    const known = this.cases.get(id)
    if (known !== undefined) return known.workflow
    for (const record of await this.ctx.sessionQuery.listSessions()) {
      using source = await this.ctx.sessionQuery.observeSession(record.header.id)
      if (!(source.projections?.values.mydotFilings ?? [])
        .some(view => view.plan.caseId === id && view.sessionId === record.header.id)) continue
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) return this.bind(live, id)
      const resolved = await this.ctx.sessionController.resolveAgent(record.header.id)
      if ('error' in resolved) throw resolved.error
      return this.bind(resolved.agent.session, id)
    }
    throw new Error('Filing not found')
  }
  /** Reserve the stable case before preparing or reading filing documents.
   * @param agent - Actual initiating Session.
   * @returns Durably reserved identity; no filing authority is granted.
   */
  async startCase(agent: Agent): Promise<FilingCaseId> {
    return this.admit(async () => {
      await this.loading
      if (!this.config.filingEnabled) throw new Error('Synthetic filing is disabled')
      this.assertOpen()
      const caseId = randomUUID().replaceAll('-', '') as FilingCaseId
      agent.session.append('mydot/filing-case', { caseId, sessionId: agent.id })
      if (!(await this.ctx.sessions.flush(agent.session))) throw new Error('Case reservation requires durable Session persistence')
      return caseId
    })
  }
  /** Prepare from the actual initiating Session; never accepts a model-selected writer.
   * @param agent - Actual tool caller.
   * @param input - Exact synthetic plan with current document digests.
   * @returns Flushed candidate carrying no owner authority.
   */
  async prepare(agent: Agent, input: FilingPlan): Promise<FilingView> {
    return this.admit(async () => {
      await this.loading
      if (!this.config.filingEnabled) throw new Error('Synthetic filing is disabled')
      const plan = filingPlanSchema.parse(input)
      using ownSource = await this.ctx.sessionQuery.observeSession(agent.id)
      if (!ownSource.events.slice(ownSource.inheritedEventCount).some(event => event.type === 'mydot/filing-case' && event.data.caseId === plan.caseId && event.data.sessionId === agent.id)) {
        throw new Error('Reserve the case in this original Session before preparing filing documents')
      }
      if (this.failed.has(plan.caseId)) throw new Error('Filing persistence is unconfirmed; restart and query')
      for (const record of await this.ctx.sessionQuery.listSessions()) {
        using source = await this.ctx.sessionQuery.observeSession(record.header.id)
        if ((source.projections?.values.mydotFilings ?? []).some(view => view.plan.caseId === plan.caseId && view.sessionId !== agent.id)) throw new Error('Case belongs to another original Session')
      }
      if (this.takeoverCase !== undefined) throw new Error('Return owner control before preparing filing documents')
      const result = await this.bind(agent.session, plan.caseId).prepare(agent.id, plan)
      this.ctx.get('goals')?.disarm(agent)
      return result
    })
  }
  /** Read owner filing cards; persisted intents alone never enable confirmation.
   * @returns Projected owner decisions and live readiness.
   */
  async snapshot(): Promise<readonly FilingCardView[]> {
    return this.admit(async () => {
      await this.loading
      if (!this.config.filingEnabled || principalOf(this.ctx.invocation) !== undefined) return []
      const result: FilingCardView[] = []
      for (const record of await this.ctx.sessionQuery.listSessions()) {
        using source = await this.ctx.sessionQuery.observeSession(record.header.id)
        for (const filing of source.projections?.values.mydotFilings ?? []) {
          if (filing.sessionId !== record.header.id) continue
          result.push({ filing: this.failed.has(filing.plan.caseId) ? { ...filing, phase: 'invalidated', reason: 'persistence-unconfirmed' } : filing,
            confirmationReady: !this.failed.has(filing.plan.caseId) && (this.cases.get(filing.plan.caseId)?.workflow.ready() ?? false) })
        }
      }
      return result
    })
  }
  /** Approve precisely the displayed revision and digest.
   * @param id - Stable case identity.
   * @param revision - Displayed revision.
   * @param digest - Server-computed digest.
   * @returns Durable owner approval without any effect.
   */
  @Remote
  async approve(id: FilingCaseId, revision: number, digest: string): Promise<FilingView> {
    this.ownerOnly(); return this.admit(async () => (await this.find(id)).approve(revision, digest))
  }
  /** Persist owner intent after closing controls and verifying independent recorder readiness.
   * @param id - Stable case identity.
   * @param revision - Owner-approved revision.
   * @param digest - Owner-approved digest.
   * @param externalControlsClosed - Explicit owner assertion about other clients and scheduled controls.
   * @returns Durable confirmation intent; no recipient invocation yet.
   */
  @Remote
  async begin(id: FilingCaseId, revision: number, digest: string, externalControlsClosed: boolean): Promise<FilingView> {
    this.ownerOnly()
    if (!externalControlsClosed) throw new Error('The owner must confirm other clients and scheduled controls are stopped')
    return this.admit(() => this.transferControl(async () => {
      const workflow = await this.find(id)
      if (this.takeoverCase !== undefined && this.takeoverCase !== id) throw new Error('Another case owns app control; finish and return it first')
      this.takeoverCase = id
      try { return await workflow.begin(revision, digest, externalControlsClosed) }
      catch (error: unknown) {
        const control = workflow.control
        if (control !== 'human' && control !== 'stopping') this.takeoverCase = undefined
        throw error
      }
    }))
  }
  /** Owner-only final synthetic confirmation; never sends to a real portal.
   * @param id - Stable case identity.
   * @param revision - Exact reviewed revision.
   * @param digest - Exact reviewed digest.
   * @returns Verified local receipt or explicit uncertainty.
   */
  @Remote
  async confirmMock(id: FilingCaseId, revision: number, digest: string): Promise<FilingView> {
    this.ownerOnly(); return this.admit(async () => (await this.find(id)).confirm(revision, digest))
  }
  /** Return app control after independent recorder stop; configured desktops still need a fresh capture.
   * @param id - Stable terminal case identity.
   * @param revision - Exact terminal revision.
   * @param digest - Exact reviewed digest.
   * @returns Durable owner return authority, separate from desktop resume.
   */
  @Remote
  async returnControl(id: FilingCaseId, revision: number, digest: string): Promise<FilingView> {
    this.ownerOnly()
    return this.admit(() => this.transferControl(async () => {
      const workflow = await this.find(id)
      if (this.takeoverCase !== undefined && this.takeoverCase !== id) throw new Error('Another case owns app control')
      const result = await workflow.returnControl(revision, digest)
      this.takeoverCase = undefined
      return result
    }))
  }
  /** Query by existing stable intent without resending, including after restart.
   * @param id - Stable case identity.
   * @returns Receipt or unresolved state.
   */
  @Remote
  async reconcile(id: FilingCaseId): Promise<FilingView> {
    this.ownerOnly(); return this.admit(async () => (await this.find(id)).reconcile())
  }
  /** Revoke an unconsumed owner decision.
   * @param id - Stable case identity.
   * @param revision - Exact displayed revision.
   * @param digest - Exact displayed digest.
   * @returns Cancellation; existing acceptance is never undone.
   */
  @Remote
  async cancel(id: FilingCaseId, revision: number, digest: string): Promise<FilingView> {
    this.ownerOnly(); return this.admit(async () => (await this.find(id)).cancel(revision, digest))
  }
  private registerTool() {
    return this.ctx.effect(function* (this: FilingService) {
      yield this.ctx.tools.register(defineTool({ name: 'start_mock_filing_case', description: 'Reserve a stable synthetic filing case in this Session before reading or preparing filing documents. No approval or external effect is granted.',
        parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: { caseId: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (_args, exec) => {
          if (exec.agent === undefined) throw new Error('Case reservation requires the initiating Session')
          return { caseId: await this.startCase(exec.agent) }
        },
      }))
      yield this.ctx.tools.register(defineTool({ name: 'prepare_mock_filing', description: 'Prepare an exact synthetic filing plan for owner review. Supply a stable case identity before work. This tool cannot approve, submit, pay, or change standing settings.',
        parameters: { plan: { type: 'json', required: true } },
        output: { schema: { type: 'object', additionalProperties: false, properties: { caseId: { type: 'string', required: true }, planDigest: { type: 'string', required: true }, revision: { type: 'integer', required: true } } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, exec) => {
          if (exec.agent === undefined) throw new Error('Filing preparation requires the initiating Session')
          if (Buffer.byteLength(JSON.stringify(args.plan)) > this.config.maxTextBytes) throw new Error('Filing exceeds configured byte allowance')
          const view = await this.prepare(exec.agent, filingPlanSchema.parse(args.plan))
          exec.concludeTurn(); return { caseId: view.plan.caseId, planDigest: view.planDigest, revision: view.revision }
        },
      }))
    }.bind(this))
  }
}
