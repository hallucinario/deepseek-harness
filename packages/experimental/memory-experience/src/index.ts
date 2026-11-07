/** Source-referenced episodic recall, isolated by host directories and root work. */
import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { joinContextSections } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { experienceDomain, episodeIdSchema } from './domain.ts'
import type { Episode, EpisodeId, ExperienceScope, Selection, SelectionId, WorkGroupId } from './domain.ts'
import { extractEpisodes, isTaskInput, localGroup, parentTurn, redact, resolveScope, textContent } from './capture.ts'
import { renderExperiences, selectExperiences } from './retrieval.ts'

export type { Episode, EpisodeId, ExperienceScope, ScopeId, Selection, WorkGroupId } from './domain.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    experienceMemory: ExperienceMemory
  }
}

/** Deployment limits; omitted fields use the defaults declared by Config. */
export interface Config {
  /** Retrieval also enables automatic capture; off keeps inspection and retirement available. */
  mode?: 'off' | 'retrieval'
  /** Complete rendered recall-message token budget, including warning and references. */
  maxTokens?: number
  /** Maximum recalled root work groups per request. */
  maxEpisodes?: number
  /** Maximum characters in one serialized episode, including metadata. */
  maxRecordChars?: number
  /** Maximum operation/result observations retained in an episode. */
  maxObservations?: number
  /** Maximum Session observations reconciled for one project recovery or lineage walk. */
  maxRecoverSessions?: number
  /** Maximum stored records examined by one listing or retrieval. */
  maxCandidates?: number
  /** Runtime-context contribution order. */
  contextOrder?: number
}

const defaults: Required<Config> = {
  mode: 'retrieval', maxTokens: 3000, maxEpisodes: 2, maxRecordChars: 12000,
  maxObservations: 24, maxRecoverSessions: 100, maxCandidates: 1000, contextOrder: 600,
}

/** Inspection status; errors remain visible after fail-soft automatic operations. */
export interface ExperienceStatus {
  mode: 'off' | 'retrieval'
  episodes: number
  selections: number
  pending: number
  recoveryExhausted: boolean
  candidatesExhausted: boolean
  lastError?: string
}

/** One model-work selection retained independently of compaction. */
interface ActiveWork {
  turn: number
  selection: Selection
}

/** Compare both directory fields as well as their persisted digest. */
function sameScope(a: ExperienceScope, b: ExperienceScope): boolean {
  return a.id === b.id && a.projectCwd === b.projectCwd && a.effectiveCwd === b.effectiveCwd
}

/** Key of one Session-owned, directory-scoped work selection. */
function selectionKey(sessionId: SessionId, group: WorkGroupId, scope: ExperienceScope): SelectionId {
  return brandString<SelectionId>(createHash('sha256').update(JSON.stringify([sessionId, group, scope.id])).digest('hex'))
}

/** Local experimental memory; its storage writes precede every visible state update. */
export default class ExperienceMemory extends Service {
  static inject = ['sessions', 'sessionQuery', 'storageDomain', 'systemPrompt', 'workingDirectory', 'tokenMeter', 'commands']

  static Config: z<Config> = z.object({
    mode: z.union(['off', 'retrieval'] as const).default(defaults.mode),
    maxTokens: z.number().min(0).step(1).default(defaults.maxTokens),
    maxEpisodes: z.number().min(0).step(1).default(defaults.maxEpisodes),
    maxRecordChars: z.number().min(1).step(1).default(defaults.maxRecordChars),
    maxObservations: z.number().min(1).step(1).default(defaults.maxObservations),
    maxRecoverSessions: z.number().min(1).step(1).default(defaults.maxRecoverSessions),
    maxCandidates: z.number().min(1).step(1).default(defaults.maxCandidates),
    contextOrder: z.number().default(defaults.contextOrder),
  })

  private readonly config: Required<Config>
  private domain?: Domain<typeof experienceDomain>
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private accepting = true
  private readonly active = new Map<SessionId, ActiveWork>()
  private readonly recovered = new Set<string>()
  private readonly suppressed = new Set<EpisodeId>()
  private recoveryExhausted = false
  private candidatesExhausted = false
  private lastError?: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'experienceMemory')
    this.config = { ...defaults, ...ExperienceMemory.Config(config) }
    for (const [key, value] of Object.entries(this.config)) {
      if (typeof value === 'number' && (key === 'contextOrder' ? !Number.isFinite(value) : !Number.isSafeInteger(value))) {
        throw new TypeError(`memory-experience: ${key} must be a ${key === 'contextOrder' ? 'finite number' : 'safe integer'}`)
      }
    }
  }

  /** Open and validate the domain before registering automatic consumers. */
  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const domain = this.domain = await ctx.storageDomain.open(experienceDomain)
    ctx.effect(() => async () => {
      this.accepting = false
      await this.tail
      this.active.clear()
      await domain.close()
    }, 'memory-experience:drain')
    ctx.systemPrompt.context({
      name: 'memory-experience', order: this.config.contextOrder, retention: 'current', interpolate: false,
      text: context => context.agent === undefined ? '' : this.currentText(context.agent.session),
    })
    ctx.commands.register({
      name: 'memory-experience', description: 'Inspect, list, retire, or check local experience memory.',
      input: { hint: 'status | list | inspect <episode-id> | retire <episode-id>' },
      handler: invocation => this.command(invocation.agent, invocation.rawInput, invocation.signal),
    })
    ctx.on('session/event', (session, event) => {
      if (this.config.mode === 'off' || !this.accepting) return
      if (event.type === 'turn/end') this.background(() => this.capture(session))
      else if (event.type === 'goal/change' && event.data.operation !== 'clear') this.background(() => this.transferGoal(session))
    })
    ctx.on('agent/created', ({ agent }) => {
      if (this.config.mode === 'off') return
      const scope = this.scope(agent.session)
      if (scope !== undefined) this.background(() => this.recover(scope))
    })
    ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next) => {
      if (messages.some(isTaskInput)) this.active.delete(agent.session.id)
      const decision = await next()
      if (decision.kind !== 'enter') { this.active.delete(agent.session.id); return decision }
      if (this.config.mode === 'off') { this.active.delete(agent.session.id); return decision }
      try {
        await this.enqueue(async () => {
          signal.throwIfAborted()
          const scope = this.scope(agent.session)
          if (scope === undefined) { this.active.delete(agent.session.id); return }
          await this.capture(agent.session)
          await this.recover(scope)
          await this.prepareSelection(agent, decision.messages, turn, scope)
          signal.throwIfAborted()
        })
      } catch (_error) {
        this.active.delete(agent.session.id)
        // enqueue records the failure; optional memory never rejects admitted user work.
        if (signal.aborted) return decision
      }
      return decision
    })
    if (this.config.mode !== 'off') {
      for (const session of ctx.sessions.list()) {
        const scope = this.scope(session)
        if (scope !== undefined) this.background(() => this.recover(scope))
      }
    }
  }

  /**
   * Await all capture, recovery, selection, and retirement operations already accepted.
   * @returns after the current owned queue has settled; failures are available in status.
   */
  async flush(): Promise<void> { await this.tail }

  /**
   * Report local runtime state without querying Session history or invoking a model.
   * @returns current counts, configured mode, exhaustion flags, and the latest operation error.
   */
  status(): ExperienceStatus {
    const domain = this.requireDomain()
    return {
      mode: this.config.mode, episodes: domain.table('episodes').size, selections: domain.table('selections').size,
      pending: this.pending, recoveryExhausted: this.recoveryExhausted, candidatesExhausted: this.candidatesExhausted,
      ...this.lastError === undefined ? {} : { lastError: this.lastError },
    }
  }

  /**
   * List bounded experiences visible from an Agent's current host directory scope.
   * @param agent - receiving Agent; absent original project identity yields no records.
   * @returns stored active and retired records in the current scope, after pending writes settle.
   */
  async list(agent: Agent): Promise<Episode[]> {
    await this.flush()
    const scope = this.scope(agent.session)
    return scope === undefined ? [] : this.candidates(scope)
  }

  /**
   * Inspect one same-scope source record, including its retirement tombstone.
   * @param agent - receiving Agent whose host directories authorize the read.
   * @param id - one opaque episode identity.
   * @returns the stored record, or absent for an unknown or other-scope identity.
   */
  async inspect(agent: Agent, id: string): Promise<Episode | undefined> {
    await this.flush()
    const scope = this.scope(agent.session)
    const value = this.requireDomain().table('episodes').get(episodeIdSchema.parse(id))
    return value !== undefined && scope !== undefined && sameScope(scope, value.scope) ? value : undefined
  }

  /**
   * Retire a same-scope record atomically; later recovery can never overwrite the tombstone.
   * @param agent - receiving Agent whose host directories authorize the mutation.
   * @param id - one opaque episode identity.
   * @returns whether a visible record exists, after its retirement is durable.
   */
  retire(agent: Agent, id: string): Promise<boolean> {
    const episodeId = episodeIdSchema.parse(id)
    const scope = this.scope(agent.session)
    if (scope === undefined) return Promise.resolve(false)
    this.suppressed.add(episodeId)
    return this.enqueue(async () => {
      const table = this.requireDomain().table('episodes')
      const record = table.get(episodeId)
      if (record === undefined || !sameScope(scope, record.scope)) { this.suppressed.delete(episodeId); return false }
      await table.update(episodeId, value => value.state === 'retired' ? value : { ...value, state: 'retired', retiredAt: Date.now() })
      for (const [key, selection] of this.requireDomain().table('selections').entries()) {
        if (selection.episodeIds.includes(episodeId)) {
          await this.requireDomain().table('selections').put(key, { ...selection, episodeIds: [], text: '' })
        }
      }
      for (const [sessionId, work] of this.active) if (work.selection.episodeIds.includes(episodeId)) this.active.delete(sessionId)
      return true
    })
  }

  private requireDomain(): Domain<typeof experienceDomain> {
    if (this.domain === undefined) throw new Error('memory-experience: domain is not initialized')
    return this.domain
  }

  private scope(session: Session): ExperienceScope | undefined {
    return resolveScope(session.header.cwd, this.ctx.workingDirectory.get(session))
  }

  private diagnose(error: unknown): string {
    this.lastError = redact(error instanceof Error ? error.message : String(error)).slice(0, this.config.maxRecordChars)
    this.ctx.logger.warn(`memory-experience: ${this.lastError}`)
    return this.lastError
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('memory-experience: service is disposing'))
    this.pending += 1
    const result = this.tail.then(operation)
    this.tail = result.then(() => { this.pending -= 1 }, (error: unknown) => { this.pending -= 1; this.diagnose(error) })
    return result
  }

  private background(operation: () => Promise<void>): void {
    void this.enqueue(operation).catch((_error: unknown) => { /* enqueue owns the visible diagnostic. */ })
  }

  private async capture(session: Session): Promise<void> {
    if (this.scope(session) === undefined) return
    const cut = session.seq
    if (!await this.ctx.sessions.flush(session)) {
      throw new Error(`source ${session.id} has no durability listener; experience was not saved`)
    }
    const snapshot = await this.ctx.sessionQuery.readSession(session.id)
    // A logical query may balance a live open turn; only its committed prefix is evidence.
    snapshot.events = snapshot.events.filter(event => event.seq < cut)
    await this.captureSnapshot(snapshot)
  }

  private async captureSnapshot(snapshot: SessionLogSnapshot): Promise<void> {
    const inheritedGroup = snapshot.session.origin === 'subagent' ? await this.rootGroup(snapshot, 1) : undefined
    if (snapshot.session.origin === 'subagent' && inheritedGroup === undefined) {
      throw new Error(`cannot attribute child ${snapshot.session.id} to a durable parent task`)
    }
    const table = this.requireDomain().table('episodes')
    for (const episode of extractEpisodes(snapshot, this.config, inheritedGroup)) {
      const stored = table.get(episode.id)
      if (stored === undefined) await table.put(episode.id, episode)
      else if (stored.groupId !== episode.groupId) await table.put(episode.id, { ...stored, groupId: episode.groupId })
    }
  }

  private async rootGroup(snapshot: SessionLogSnapshot, turn: number): Promise<WorkGroupId | undefined> {
    const seen = new Set<SessionId>()
    let observed = snapshot
    let currentTurn = turn
    while (observed.session.origin === 'subagent') {
      const parentId = observed.session.parentSession
      if (parentId === undefined || seen.has(parentId) || seen.size >= this.config.maxRecoverSessions) return undefined
      seen.add(parentId)
      const parent = await this.ctx.sessionQuery.readSession(parentId)
      if (parent.session.cwd !== snapshot.session.cwd) return undefined
      const createdIn = parentTurn(parent, observed.session.id)
      if (createdIn === undefined) return undefined
      observed = parent
      currentTurn = createdIn
    }
    return localGroup(observed, currentTurn)
  }

  private async recover(scope: ExperienceScope): Promise<void> {
    if (this.recovered.has(scope.id)) return
    const records = await this.ctx.sessionQuery.filterSessions([{ kind: 'cwd', values: [scope.projectCwd] }])
    this.recoveryExhausted = records.length > this.config.maxRecoverSessions
    if (this.recoveryExhausted) this.diagnose(new Error(
      `recovery limit ${this.config.maxRecoverSessions} reached: ${records.length} matching Sessions; `
      + 'increase maxRecoverSessions to reconcile the remainder',
    ))
    for (const record of records.slice(0, this.config.maxRecoverSessions)) {
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) await this.capture(live)
      else if (record.persisted) await this.captureSnapshot(await this.ctx.sessionQuery.readSession(record.header.id))
    }
    this.recovered.add(scope.id)
  }

  private candidates(scope: ExperienceScope): Episode[] {
    const table = this.requireDomain().table('episodes')
    this.candidatesExhausted = table.size > this.config.maxCandidates
    if (this.candidatesExhausted) this.diagnose(new Error(
      `candidate limit ${this.config.maxCandidates} reached: ${table.size} stored records; increase maxCandidates to search the remainder`,
    ))
    const result: Episode[] = []
    let scanned = 0
    for (const [, value] of table.entries()) {
      if (scanned >= this.config.maxCandidates) break
      scanned += 1
      if (sameScope(scope, value.scope)) result.push(value)
    }
    return result
  }

  private async prepareSelection(
    agent: Agent, messages: readonly UserMessage[], turn: number, scope: ExperienceScope,
  ): Promise<void> {
    const snapshot = await this.ctx.sessionQuery.readSession(agent.session.id)
    const task = messages.find(isTaskInput)
    let groupId = await this.rootGroup(snapshot, turn)
    if (groupId === undefined) throw new Error(`cannot resolve root task for ${agent.session.id}`)
    if (snapshot.session.origin !== 'subagent' && task?.source.kind === 'goal') {
      groupId = brandString<WorkGroupId>(`${agent.session.id}:goal:${task.source.goalId}`)
    }
    const key = selectionKey(agent.session.id, groupId, scope)
    const table = this.requireDomain().table('selections')
    let selection = table.get(key)
    if (selection === undefined) {
      if (task === undefined) { this.active.delete(agent.session.id); return }
      const chosen = selectExperiences(this.candidates(scope), this.recallQuery(snapshot, task), groupId, this.config.maxEpisodes)
      const estimate = (text: string): number => this.ctx.tokenMeter.estimateMessage(createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: joinContextSections([{ name: 'memory-experience', text }]) }],
      }))
      const rendered = renderExperiences(chosen, this.config.maxTokens, estimate)
      selection = { sessionId: agent.session.id, scope, groupId, ...rendered }
      await table.put(key, selection)
    }
    this.active.set(agent.session.id, { turn, selection })
  }

  /** Use only admitted human/goal context to resolve a continuation's references. */
  private recallQuery(snapshot: SessionLogSnapshot, task: UserMessage): string {
    const current = textContent(task.content)
    const continuation = /\b(?:continue|again|same|still)\b|続け|同じ|再度|もう一度|继续|再试/iu.test(current)
    if (task.source.kind !== 'goal' && !continuation) return redact(current)
    const previous = snapshot.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const goal = snapshot.events.findLast(event => event.type === 'goal/change')
    const context = [current]
    if (previous?.type === 'user/message') context.push(textContent(previous.data.content))
    if (goal?.type === 'goal/change' && goal.data.operation !== 'clear') context.push(goal.data.goal.objective)
    return redact(context.join('\n'))
  }

  private async transferGoal(session: Session): Promise<void> {
    const snapshot = await this.ctx.sessionQuery.readSession(session.id)
    const groups = new Map<WorkGroupId, WorkGroupId>()
    for (const event of snapshot.events) {
      if (event.seq < snapshot.inheritedEventCount || event.type !== 'turn/start') continue
      const group = await this.rootGroup(snapshot, event.data.turn)
      if (group !== undefined) groups.set(brandString<WorkGroupId>(`${session.id}:turn:${event.data.turn}`), group)
    }
    const episodes = this.requireDomain().table('episodes')
    for (const [id, stored] of episodes.entries()) {
      const groupId = groups.get(stored.groupId)
      if (groupId !== undefined && groupId !== stored.groupId) await episodes.put(id, { ...stored, groupId })
    }
    const work = this.active.get(session.id)
    if (work === undefined) return
    const groupId = await this.rootGroup(snapshot, work.turn)
    if (groupId === undefined || groupId === work.selection.groupId) return
    const selection = { ...work.selection, groupId }
    const table = this.requireDomain().table('selections')
    const key = selectionKey(session.id, groupId, selection.scope)
    const restored = table.get(key)
    if (restored === undefined) await table.put(key, selection)
    this.active.set(session.id, { ...work, selection: restored ?? selection })
  }

  private currentText(session: Session): string {
    if (this.config.mode === 'off') return ''
    const work = this.active.get(session.id)
    const scope = this.scope(session)
    if (work === undefined || scope === undefined || !sameScope(scope, work.selection.scope)) return ''
    const table = this.requireDomain().table('episodes')
    if (work.selection.episodeIds.some((id) => {
      const episode = table.get(id)
      return this.suppressed.has(id) || episode === undefined || episode.state === 'retired' || !sameScope(scope, episode.scope)
    })) return ''
    return work.selection.text
  }

  private async command(agent: Agent, input: string, signal: AbortSignal): Promise<CommandResult> {
    const [operation = 'status', id, ...rest] = input.trim().split(/\s+/u).filter(Boolean)
    try {
      signal.throwIfAborted()
      if (rest.length > 0) return { kind: 'error', text: 'Expected one episode id.' }
      if (operation === 'status' && id === undefined) return { kind: 'success', text: JSON.stringify(this.status(), null, 2) }
      if (operation === 'list' && id === undefined) return { kind: 'success', text: JSON.stringify(await this.list(agent), null, 2) }
      if (id === undefined) return { kind: 'error', text: 'Use status, list, inspect <episode-id>, or retire <episode-id>.' }
      if (operation === 'inspect') {
        const record = await this.inspect(agent, id)
        return record === undefined
          ? { kind: 'error', text: 'No experience with that id in this directory scope.' }
          : { kind: 'success', text: JSON.stringify(record, null, 2) }
      }
      if (operation === 'retire') return await this.retire(agent, id)
        ? { kind: 'success', text: `Retired experience ${id}.` }
        : { kind: 'error', text: 'No experience with that id in this directory scope.' }
      return { kind: 'error', text: 'Use status, list, inspect <episode-id>, or retire <episode-id>.' }
    } catch (error) {
      return { kind: 'error', text: `Experience memory failed: ${this.diagnose(error)}` }
    }
  }
}
