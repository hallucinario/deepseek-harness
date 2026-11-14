/** Opt-in MyDot Host service composed over existing Session, Subagent and file services. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { FsVersion } from '@deepseek-ai/dsh-fs/types'
import type { SubagentPromptReceipt, SubagentInterruptReceipt } from '@deepseek-ai/dsh-subagent'
import type { SessionPromptValue } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import { mydotDomain } from './storage.ts'
import type { SpaceId, SpaceInput, Space, JobInput, JobAddress } from './types.ts'
import { readJobRequest } from './job-request.ts'
import { relayArtifacts } from './artifacts.ts'
import { Spaces } from './spaces.ts'
import { TextFiles, type TextRead, type TextSave, type TextSaveResult } from './files.ts'
import { JobControls } from './control.ts'
import { DesktopOwnership, type DesktopState } from './desktop.ts'
import type { ArtifactView, MyDotSnapshot, StartJob, MemoryScope } from './types.ts'
import { FilingService, type FilingConfig } from './filing-service.ts'
export { FilingService } from './filing-service.ts'
export type * from './filing-types.ts'
import { HumanHandoffService, type HumanHandoffConfig } from './human-handoff.ts'
export { HumanHandoffService } from './human-handoff.ts'
export type { HumanHandoffConfig, PrepareHumanInput } from './human-handoff.ts'

export type * from './types.ts'
export type { SpaceId, SpaceInput, Space } from './storage.ts'
export type { JobInput, JobAddress } from './control.ts'
export type { TextRead, TextSave, TextSaveResult } from './files.ts'
export type { DesktopState } from './desktop.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { mydot: MyDotService }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'mydot': { kind: 'mydot' } & Extract<ContextFormed, { form: 'snapshot' }> }
}

/** Explicit opt-in composition limits; the plugin never starts a desktop tool itself. */
export interface Config extends HumanHandoffConfig, FilingConfig {
  /** Host directory containing personal and Space Markdown memory. */
  memoryDirectory: string
  /** Maximum UTF-8 bytes admitted by the current-file editor. */
  maxTextBytes: number
  /** Complete tool-name set sharing one physical desktop; empty disables coordination. */
  desktopTools: string[]
  /** Read-only image-capture tools within desktopTools, also allowed during human ownership. */
  captureTools: string[]
  /** Maximum characters quoted from a job’s latest logged assistant output. */
  summaryCharacters: number
}

/** MyDot metadata, projected work and current-file access. */
export class MyDotService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionController', 'sessions', 'sessionQuery', 'subagents', 'fs', 'sandboxPolicy', 'workingDirectory', 'tools', 'agents']
  static Config: z<Config> = z.object({
    memoryDirectory: z.string().default(join(homedir(), 'MyDot')),
    maxTextBytes: z.number().step(1).min(1).default(262144),
    desktopTools: z.array(z.string()).default([]),
    captureTools: z.array(z.string()).default([]),
    summaryCharacters: z.number().step(1).min(1).default(240),
    filingEnabled: z.boolean().default(false),
    filingRecorderSocketPath: z.string(),
    filingRecorderTimeoutMs: z.number().step(1).min(1),
    filingRecorderMaxAgeMs: z.number().step(1).min(1),
    humanHandoffEnabled: z.boolean().default(false),
    humanHandoffSocketPath: z.string().default(''),
    humanHandoffSurveyOrigin: z.string().default(''),
    humanHandoffTimeoutMs: z.number().step(1).min(1),
  })

  private domain!: Domain<typeof mydotDomain>
  private spaces!: Spaces
  private readonly files: TextFiles
  private readonly controls: JobControls
  private readonly desktop = new DesktopOwnership()
  private readonly initialized: PromiseLike<unknown>
  private readonly changed = new Set<() => void>()
  private readonly lifecycle = new AbortController()
  private readonly pendingSpaces = new Map<SessionId, Space>()
  private readonly starts = new Map<SessionId, { request: string; result: Promise<{ childSessionId: SessionId }> }>()
  private filingTakeover = false
  private filingRecovering = false
  private filingAdmissions = new AbortController()
  private filingReturning = false
  private filingInFlight = 0
  private readonly filingDrained = new Set<() => void>()
  private revision = 0
  private readonly presentations = new Map<SessionId, Promise<void>>()
  private readonly deliveries = new Set<Promise<void>>()
  private readonly deliveryFailures = new Set<SessionId>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'mydot')
    if (config.captureTools.some(tool => !config.desktopTools.includes(tool))) throw new Error('captureTools must be a subset of desktopTools')
    this.files = new TextFiles(ctx.fs, config.maxTextBytes)
    this.controls = new JobControls(ctx)
    this.filingRecovering = config.filingEnabled === true
    ctx.plugin(HumanHandoffService, config)
    ctx.plugin(FilingService, { ...config, takeover: async (sessionId) => {
      this.filingTakeover = true
      this.filingReturning = false
      this.filingAdmissions.abort(new Error('Filing takeover closes queued desktop admission'))
      if (config.desktopTools.length > 0) {
        if (this.desktop.snapshot().phase === 'free') this.desktop.claim(sessionId)
        this.desktop.requestHandoff()
      }
      this.notify()
      if (this.filingInFlight !== 0) await new Promise<void>((resolve) => { this.filingDrained.add(resolve) })
      const jobs = ctx.get('jobs')
      if (jobs !== undefined) {
        const active = (owner?: SessionId) => jobs.list(owner).some(job => job.status === 'running' || job.status === 'stopping')
        if (active() || ctx.sessions.list().some(session => active(session.id))) {
          throw new Error('Background jobs must finish or stop before filing takeover')
        }
      }
    }, returnControl: () => {
      if (config.desktopTools.length > 0 && config.captureTools.length === 0) throw new Error('Configure a fresh capture before returning desktop control')
      this.filingAdmissions = new AbortController()
      this.filingReturning = config.desktopTools.length > 0
      if (config.desktopTools.length === 0) this.filingTakeover = false
      this.notify()
      return Promise.resolve()
    }, read: async (sessionId, path) => {
      const file = await this.readFile(sessionId, path)
      if (file.kind !== 'text') throw new Error('Filing source or preview is missing')
      return file.content
    }, recovered: () => { this.filingRecovering = false; this.notify() } })
    ctx.on('mydot/handoff-changed', () => { this.notify() })
    this.initialized = ctx.effect(async () => {
      this.domain = await ctx.storageDomain.open(mydotDomain)
      this.spaces = new Spaces(this.domain)
      return async () => {
        this.lifecycle.abort()
        this.notify()
        await Promise.allSettled([...this.starts.values()].map(start => start.result))
        await Promise.allSettled(this.deliveries)
        await this.spaces.drain()
        await this.domain.close()
      }
    })
    ctx.on('domain/changed', (event) => { if (event.domain === 'mydot') this.notify() })
    ctx.on('agent/status', () =>{  this.notify() })
    ctx.on('subagent/end', (info) => {
      const desktop = this.desktop.snapshot()
      if (desktop.owner === info.id && desktop.phase === 'agent' && desktop.inFlight === 0) this.desktop.release(info.id)
      this.notify()
    })
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'deliverables/presented' || event.type === 'subagent/catalog') this.notify()
    })
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      await this.initialized
      const space = this.spaces.forSession(agent.id) ?? this.pendingSpaces.get(agent.id)
      if (space === undefined) return decision
      const personal = await this.files.read(this.memoryPath({ kind: 'personal' }))
      const scoped = await this.files.read(this.memoryPath({ kind: 'space', spaceId: space.id }))
      const text = JSON.stringify({ space: { id: space.id, name: space.name, purpose: space.purpose,
        instructions: space.instructions, materials: space.materials },
      memory: [personal, scoped].filter(item => item.kind === 'text') })
      return { ...decision, messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }], source: { kind: 'mydot', form: 'snapshot', sections: [{ name: 'mydot', text }] },
      })] }
    }, { prepend: true })
    ctx.on('tools/execute', async (exec, next) => {
      if (this.filingRecovering) throw new Error('Filing ownership recovery is pending')
      if (this.filingTakeover && !(this.filingReturning && config.captureTools.includes(exec.name) && exec.agent?.id === this.desktop.snapshot().owner)) throw new Error('Owner filing takeover blocks all app tool control and capture; query the existing intent')
      this.filingInFlight += 1
      try {
        if (!config.desktopTools.includes(exec.name) || exec.agent === undefined) return await next()
        const finished = await this.desktop.acquire(
          exec.agent.id, AbortSignal.any([exec.signal, this.lifecycle.signal, this.filingAdmissions.signal]),
          config.captureTools.includes(exec.name),
        )
        this.notify()
        try {
          const result = await next()
          if (config.captureTools.includes(exec.name) && !result.isError && result.content.some(block => block.type === 'image')) this.desktop.observed(Date.now())
          return result
        } finally { finished(); this.notify() }
      } finally {
        this.filingInFlight -= 1
        if (this.filingInFlight === 0) { for (const resolve of this.filingDrained) resolve(); this.filingDrained.clear() }
      }
    })
  }

  async [Service.init](): Promise<void> { await this.initialized }

  /** Save observed Space metadata without mutating Session history or files.
   * @param input - New metadata or optimistic replacement.
   * @returns Committed Space.
   */
  @Remote
  async saveSpace(input: SpaceInput): Promise<Space> { await this.initialized; return this.spaces.save(input) }

  /** Start a fresh conversation in the Space's selected Workspace.
   * @param spaceId - Non-archived Space.
   * @returns New Session; association failure rejects without claiming a rollback of Session creation.
   */
  @Remote
  async createConversation(spaceId: SpaceId): Promise<{ sessionId: SessionId }> {
    await this.initialized
    const space = this.spaces.list().find(item => item.id === spaceId)
    if (space === undefined || space.archived) throw new Error('Select a non-archived Space')
    const result = await this.ctx.sessionController.create({
      ...(space.workspaceId === undefined ? {} : { workspaceId: space.workspaceId }),
    })
    await this.spaces.attach(result.sessionId, spaceId)
    this.notify()
    return { sessionId: result.sessionId }
  }

  /** Bind an existing conversation once without changing its execution directory.
   * @param sessionId - Existing Session.
   * @param spaceId - Selected Space.
   */
  @Remote
  async attach(sessionId: SessionId, spaceId: SpaceId): Promise<void> {
    await this.initialized
    using observation = await this.ctx.sessionQuery.observeSession(sessionId)
    void observation
    await this.spaces.attach(sessionId, spaceId)
    this.notify()
  }

  /** Start a continuable local child under a stable caller-minted identity.
   * @param request - Exact parent and independently selected local provider.
   * @param signal - Caller cancellation before publication.
   * @returns Child identity; results are delivered through the existing parent channel.
   */
  @Remote
  async startJob(request: StartJob, signal: AbortSignal): Promise<{ childSessionId: SessionId }> {
    await this.initialized
    if (request.label.trim() === '' || request.prompt.trim() === '') throw new Error('A job needs a name and request')
    const serialized = JSON.stringify({ parentSessionId: request.parentSessionId, requestId: request.requestId, label: request.label,
      prompt: request.prompt, provider: request.provider })
    const prompt = 'MyDot job request: ' + serialized
    const childSessionId = SessionId(`mydot-${request.requestId}`)
    const running = this.starts.get(childSessionId)
    if (running !== undefined) {
      if (running.request !== serialized) throw new Error('Request identity was reused with different job input')
      return running.result
    }
    const run = (async () => {
      const catalog = await this.ctx.subagents.listChildren(request.parentSessionId, signal)
      if (catalog.some(child => child.id === childSessionId)) {
        using source = await this.ctx.sessionQuery.observeSession(childSessionId)
        const messages = source.events.flatMap(event => event.type === 'user/message' ? [event.data]
          : event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
        if (!messages.some(message => message.content.some(block => block.type === 'text' && block.text === prompt))) {
          throw new Error('Request identity was reused with different job input')
        }
        return { childSessionId }
      }
      const parent = this.ctx.agents.get(request.parentSessionId)
      if (parent === undefined) throw new Error('Resume the original parent conversation before starting a job')
      const space = this.spaces.forSession(request.parentSessionId)
      if (space !== undefined) this.pendingSpaces.set(childSessionId, space)
      const activation = await this.ctx.subagents.startActivation({
        childId: childSessionId, provider: request.provider, label: request.label,
        request: { parent, prompt: [{ type: 'text', text: prompt }] }, signal, delivery: 'parent',
      })
      if (space !== undefined) await this.spaces.inherit(request.parentSessionId, childSessionId)
      const delivery = activation.result.then(async () => {
        if (!this.lifecycle.signal.aborted) await this.presentResults(request.parentSessionId)
      }).catch((error: unknown) => {
        this.deliveryFailures.add(request.parentSessionId)
        this.ctx.logger.warn(`MyDot results remain in the child conversation; reopen the parent and retry presentation: ${String(error)}`)
      }).finally(() => { this.deliveries.delete(delivery); this.notify() })
      this.deliveries.add(delivery)
      this.notify()
      return { childSessionId }
    })()
    this.starts.set(childSessionId, { request: serialized, result: run })
    try { return await run } finally { this.starts.delete(childSessionId); this.pendingSpaces.delete(childSessionId) }
  }

  /** Admit a targeted message using the existing durable deduplication key.
   * @param request - Exact address and stable request ID.
   * @param signal - Cancellation before admission.
   * @returns Existing inbox receipt; consumption remains observable in Session history.
   */
  @Remote
  send(request: JobInput, signal: AbortSignal): Promise<SubagentPromptReceipt> { return this.controls.send(request, signal) }

  /** Request a child's cancellation while preserving pending input.
   * @param address - Exact direct parent and continuable child.
   * @returns Admission receipt, not a claim of completed stopping.
   */
  @Remote
  stop(address: JobAddress): SubagentInterruptReceipt { return this.controls.stop(address) }

  /** Read source-linked current artifacts and existing child states without activating Sessions.
   * @returns Metadata and derived lists; missing files remain listed explicitly.
   */
  @Remote
  async snapshot(): Promise<MyDotSnapshot> {
    await this.initialized
    const spaces = this.spaces.list()
    const conversations: MyDotSnapshot['conversations'] = []
    const jobs: MyDotSnapshot['jobs'] = []
    const artifacts = new Map<string, ArtifactView>()
    const issues: NonNullable<MyDotSnapshot['issues']> = [...this.deliveryFailures].map(sessionId => ({ sessionId, kind: 'artifact-delivery' }))
    const bindings = new Map(this.domain.table('sessions').entries())
    const parents = new Map<SessionId, SessionId>()
    for (const [sessionId, binding] of bindings) {
      try {
        for (const child of await this.ctx.subagents.listChildren(sessionId)) {
          parents.set(child.id, sessionId)
          if (child.mode !== 'external' && !bindings.has(child.id)) bindings.set(child.id, binding)
          jobs.push({ parentSessionId: sessionId, childSessionId: child.id, label: child.label ?? child.id,
            mode: child.mode, status: this.ctx.agents.get(child.id)?.status === 'running' ? 'running' : 'inactive' })
        }
      } catch (error: unknown) {
        issues.push({ sessionId, kind: 'unavailable' })
        this.ctx.logger.warn(`MyDot could not read a child catalog: ${String(error)}`)
      }
    }
    for (const [sessionId, binding] of bindings) {
      try {
        using source = await this.ctx.sessionQuery.observeSession(sessionId)
        const cwd = source.projections?.values.workingDirectory ?? source.header.cwd ?? this.ctx.workingDirectory.defaultDirectory
        conversations.push({ sessionId, spaceId: binding.spaceId, cwd })
        const job = jobs.find(item => item.childSessionId === sessionId)
        if (job !== undefined) {
          for (const event of source.events.slice(source.inheritedEventCount)) {
            if (event.type === 'user/message' && job.request === undefined) {
              for (const block of event.data.content) {
                if (block.type === 'text') job.request = readJobRequest(block.text)
              }
            }
            if (event.type === 'assistant/message') {
              job.summary = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ').slice(0, this.config.summaryCharacters)
            }
          }
        }
        for (const event of source.events.slice(source.inheritedEventCount)) {
          if (event.type !== 'deliverables/presented') continue
          for (const file of event.data.files) {
            const target = await this.ctx.fs.resolve(file.path, { cwd })
            const path = this.ctx.fs.processPath(target)
            artifacts.set(sessionId + ':' + path, { sessionId, parentSessionId: parents.get(sessionId) ?? sessionId,
              path, ...(file.description === undefined ? {} : { description: file.description }),
              available: (await this.ctx.fs.stat(target))?.type === 'file' })
          }
        }
      } catch (error: unknown) {
        issues.push({ sessionId, kind: 'unavailable' })
        this.ctx.logger.warn(`MyDot retains the Space association but could not read its Session or files: ${String(error)}`)
      }
    }
    const humanRequests = principalOf(this.ctx.invocation) === undefined ? await this.ctx.get('mydotHandoff')?.snapshot() : []
    const filings = principalOf(this.ctx.invocation) === undefined ? await this.ctx.get('mydotFiling')?.snapshot() : []
    return { filings, spaces, conversations, jobs, artifacts: [...artifacts.values()], desktop: this.desktop.snapshot(), humanRequests,
      desktopEnabled: this.config.desktopTools.length > 0, issues }
  }

  /** Retry parent inbox presentation from the existing durable child declarations.
   * @param parentSessionId - Original live parent; cold parents must first be reopened.
   * @returns Resolution after the parent has accepted every missing reference.
   */
  @Remote
  async presentResults(parentSessionId: SessionId): Promise<void> {
    await this.initialized
    const previous = this.presentations.get(parentSessionId) ?? Promise.resolve()
    const work = previous.catch(() => undefined).then(async () => {
      for (const child of await this.ctx.subagents.listChildren(parentSessionId)) {
        if (child.mode === 'continuable') await relayArtifacts(this.ctx, parentSessionId, child.id)
      }
      this.deliveryFailures.delete(parentSessionId)
      this.notify()
    })
    this.presentations.set(parentSessionId, work)
    try { await work } finally { if (this.presentations.get(parentSessionId) === work) this.presentations.delete(parentSessionId) }
  }

  /** Stream replacement snapshots over the existing Remote WebSocket carrier.
   * @param signal - Subscription cancellation, including reconnect/unload.
   * @returns Initial snapshot and subsequent committed metadata/execution changes.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<MyDotSnapshot> {
    const lifetime = AbortSignal.any([signal, this.lifecycle.signal])
    while (!lifetime.aborted) {
      const revision = this.revision
      yield await this.snapshot()
      if (revision !== this.revision) continue
      await new Promise<void>((resolve) => {
        const changed = (): void => { this.changed.delete(changed); lifetime.removeEventListener('abort', changed); resolve() }
        this.changed.add(changed)
        lifetime.addEventListener('abort', changed, { once: true })
        if (revision !== this.revision || lifetime.aborted) changed()
      })
    }
  }

  /** Read a referenced text file without capturing a fixed artifact version.
   * @param sessionId - Source conversation for path authorization.
   * @param path - Material, artifact or file within that Session's execution directory.
   * @returns Current content/version or explicit absence.
   */
  @Remote
  async readFile(sessionId: SessionId, path: string): Promise<TextRead> {
    const target = await this.authorizeFile(sessionId, path)
    return this.files.read(target.path)
  }

  /** Persist a user edit atomically against its observed version.
   * @param sessionId - Source conversation.
   * @param request - Authorized file, draft and version.
   * @returns Saved version or retained conflict draft and current content.
   */
  @Remote
  async saveFile(sessionId: SessionId, request: TextSave): Promise<TextSaveResult> {
    const target = await this.authorizeFile(sessionId, request.path)
    return this.files.save({ ...request, path: target.path }, target.policy)
  }

  /** Queue continuation with the exact saved file/version recorded as user input.
   * @param sessionId - Source conversation receiving the follow-up.
   * @param path - Saved referenced file.
   * @param version - Version confirmed by the editor.
   * @param requestId - Stable caller-minted inbox identity.
   * @param signal - Cancellation before inbox admission.
   * @returns Existing Session prompt receipt.
   */
  @Remote
  async continueFile(
    sessionId: SessionId, path: string, version: FsVersion, requestId: SessionRequestId, signal: AbortSignal,
  ): Promise<SessionPromptValue> {
    const current = await this.readFile(sessionId, path)
    if (current.kind !== 'text' || current.version !== version) throw new Error('File changed after saving; reload before continuing')
    return this.ctx.sessionController.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text:
      'Continue using the saved file. Read it again before working. ' + JSON.stringify({ path: current.path, version }) }] }, signal)
  }

  /** Read scoped Markdown memory with its source path.
   * @param scope - Personal or one exact Space.
   * @returns Editable current source, distinct from execution-experience memory.
   */
  @Remote
  async readMemory(scope: MemoryScope): Promise<TextRead> {
    await this.initialized
    this.validateMemory(scope)
    return this.files.read(this.memoryPath(scope))
  }

  /** Save one memory source with the same optimistic edit semantics as documents.
   * @param scope - Personal or one exact Space.
   * @param request - Draft and observed version; path is chosen by the Host.
   * @returns Saved version or current content and retained draft.
   */
  @Remote
  async saveMemory(scope: MemoryScope, request: Omit<TextSave, 'path'>): Promise<TextSaveResult> {
    await this.initialized
    this.validateMemory(scope)
    const mode = this.ctx.fs.sandboxMode
    return this.files.save({ ...request, path: this.memoryPath(scope) }, mode === undefined ? undefined : {
      mode, workspaceRoot: this.config.memoryDirectory,
    })
  }

  /** Stop new desktop tool admission before allowing the person to edit.
   * @returns Stopping until admitted tool bodies settle, then human ownership.
   */
  @Remote
  handoffDesktop(): DesktopState {
    if (this.config.desktopTools.length === 0) throw new Error('Configure desktop tool admission before using handoff')
    const result = this.desktop.requestHandoff(); this.notify(); return result }

  /** Resume only against a newly captured frame after human ownership.
   * @param owner - Original controlling Session.
   * @param capturedAt - Exact new observation timestamp.
   * @returns Agent ownership; no desktop action is launched by this method.
   */
  @Remote
  resumeDesktop(owner: SessionId, capturedAt: number): DesktopState {
    if (this.filingTakeover && !this.filingReturning) throw new Error('Filing takeover requires explicit return authority')
    const result = this.desktop.resume(owner, capturedAt)
    if (this.filingReturning) { this.filingTakeover = false; this.filingReturning = false }
    this.notify()
    return result
  }

  /** Release a quiescent desktop so the next waiting job can own it.
   * @param owner - Exact current agent owner.
   * @returns New ownership state; human handoff cannot be bypassed.
   */
  @Remote
  releaseDesktop(owner: SessionId): DesktopState { this.desktop.release(owner); this.notify(); return this.desktop.snapshot() }

  private memoryPath(scope: MemoryScope): string {
    return scope.kind === 'personal' ? join(this.config.memoryDirectory, 'MEMORY.md') : join(this.config.memoryDirectory, 'spaces', scope.spaceId, 'MEMORY.md')
  }
  private validateMemory(scope: MemoryScope): void {
    if (scope.kind === 'space' && !this.spaces.list().some(space => space.id === scope.spaceId)) throw new Error('Space not found')
  }
  private async authorizeFile(sessionId: SessionId, path: string): Promise<{ path: string; policy: Parameters<TextFiles['save']>[1] }> {
    await this.initialized
    using source = await this.ctx.sessionQuery.observeSession(sessionId)
    const cwd = source.projections?.values.workingDirectory ?? source.header.cwd ?? this.ctx.workingDirectory.defaultDirectory
    const target = await this.ctx.fs.resolve(path, { cwd })
    const root = await this.ctx.fs.resolve(cwd)
    const mode = this.ctx.fs.sandboxMode
    const authorized = { path: this.ctx.fs.processPath(target), policy: mode === undefined ? undefined : {
      ...this.ctx.sandboxPolicy.resolveRecorded(source.header, source.events), workspaceRoot: cwd,
    } }
    if (this.ctx.fs.contains(root, target)) return authorized
    const space = this.spaces.forSession(sessionId)
    for (const reference of space?.materials ?? []) {
      if ((await this.ctx.fs.resolve(reference, { cwd })).targetKey === target.targetKey) return authorized
    }
    for (const event of source.events) {
      if (event.type !== 'deliverables/presented') continue
      for (const file of event.data.files) {
        if ((await this.ctx.fs.resolve(file.path, { cwd })).targetKey === target.targetKey) return authorized
      }
    }
    throw new Error('Select a file referenced by this conversation or Space')
  }
  private notify(): void { this.revision += 1; for (const listener of [...this.changed]) listener() }
}

export default MyDotService
