/** Capability-owned Remote operations for explicit, durable MyDot CI observations. */
import { isDeepStrictEqual } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { appendPluginRecord, createPluginRecord, SessionSeq } from '@deepseek-ai/dsh-session'
import type { PluginRecordMap, Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { VerificationCheck, VerificationTarget, VerificationTargetInput, VerificationView } from './verification-types.ts'
import { foldVerification, verificationCheckRevision, verificationCheckSchema, verificationProjection, verificationView } from './verification-records.ts'
import type { VerificationState } from './verification-records.ts'
import { readGitHubVerification } from './verification-github.ts'
import type { VerificationResult } from './verification-github.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { mydotEvidence: MyDotEvidence }
}

/** Validated transport bounds and explicitly reviewed CI conditions. */
export interface EvidenceConfig {
  checks: VerificationCheck[]
  timeoutMs: number
  maxOutputBytes: number
  changed: () => void
}

/** Stable admission failures; provider failures are persisted observations instead. */
export class VerificationError extends Error {
  constructor(readonly code: 'session-unavailable' | 'invalid-target' | 'stale-target' | 'not-durable') {
    super(code)
    this.name = 'VerificationError'
  }
}

type EvidenceRecordType = 'plugin:mydot/verification-target' | 'plugin:mydot/verification-observation'
interface EvidenceWriter {
  header: SessionHeader
  nextSeq: number
  state: VerificationState
  append: <K extends EvidenceRecordType>(type: K, data: NoInfer<PluginRecordMap[K]>) => Promise<SessionSeq>
  flush: () => Promise<void>
}

/** Persistence may materialize optional header defaults; these fields identify the same Session. */
function sameSessionIdentity(left: SessionHeader, right: SessionHeader): boolean {
  return isDeepStrictEqual([left.id, left.createdAt, left.cwd], [right.id, right.createdAt, right.cwd])
}

/** User-triggered CI reads; never starts a model turn, test, retry, or external write. */
export class MyDotEvidence extends TypertRemoteService {
  static inject = ['sessions', 'sessionQuery', 'sessionProjections', 'subprocess', 'workingDirectory']
  private readonly lifecycle = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly refreshing = new Map<SessionId, Promise<void>>()
  private readonly acknowledged = new WeakMap<Session | SessionHeader, number>()
  private readonly flushing = new WeakMap<Session, { through: number; done: Promise<void> }>()
  private readonly writing = new Map<SessionId, Promise<unknown>>()

  constructor(ctx: Context, readonly config: EvidenceConfig) {
    super(ctx, 'mydotEvidence')
    config.checks.forEach(check => verificationCheckSchema.parse(check))
    if (new Set(config.checks.map(check => check.id)).size !== config.checks.length) throw new Error('verificationChecks identities must be unique')
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647
      || !Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 1) throw new Error('Invalid verification transport bounds')
    const lifecycle = this.lifecycle
    const pending = this.pending
    ctx.effect(function* () {
      yield ctx.sessionProjections.register(verificationProjection)
      yield async () => {
        lifecycle.abort()
        await Promise.allSettled(pending)
      }
    }, 'mydot: drain verification before unregistering projection')
  }

  /** Publish only evidence that reached the existing Session durability checkpoint.
   * @param source - One exact live or persisted projection cut from SessionQuery.
   * @returns Current evidence; failed checkpoints retain only the acknowledged prefix.
   */
  async view(source: SessionObservation): Promise<VerificationView> {
    const state = source.projections?.values.mydotEvidence
    if (state === undefined) throw new VerificationError('session-unavailable')
    const session = source.source === 'live' ? this.live(source.header.id) : undefined
    if (session !== undefined && session.header !== source.header) throw new VerificationError('session-unavailable')
    const identity = session ?? source.header
    const latest = Math.max(state.targets.at(-1)?.seq ?? -1, state.observations.at(-1)?.seq ?? -1)
    if (latest > (this.acknowledged.get(identity) ?? -1)) {
      try {
        if (session !== undefined) await this.flush(session)
        else await this.withWriter(source.header.id, async (writer) => {
          if (!sameSessionIdentity(writer.header, source.header) || writer.nextSeq <= source.cursor) {
            throw new VerificationError('session-unavailable')
          }
          await writer.flush()
          this.acknowledged.set(identity, source.cursor)
        })
      } catch (error: unknown) {
        const through = this.acknowledged.get(identity) ?? -1
        this.ctx.logger.warn(`MyDot evidence could not reach its Session durability checkpoint: ${String(error)}`)
        const confirmed = { ...state, targets: state.targets.filter(target => target.seq <= through),
          observations: state.observations.filter(observation => observation.seq <= through) }
        return { ...verificationView(confirmed, this.config.checks), status: 'unavailable' }
      }
    }
    return verificationView(state, this.config.checks)
  }

  /** Bind a local request and configured condition to an exact commit.
   * @param sessionId - Live or stored source Session whose own user message is selected.
   * @param input - Request position, condition identity and full commit SHA.
   * @returns The persisted immutable selection; selecting it again is idempotent.
   */
  @Remote({ resources: { session: sessionId => sessionId } })
  async setTarget(sessionId: SessionId, input: VerificationTargetInput): Promise<VerificationTarget> {
    this.lifecycle.signal.throwIfAborted()
    return this.withWriter(sessionId, async ({ state, append, flush }) => {
      const check = this.config.checks.find(item => item.id === input.checkId)
      const request = state.requests.find(item => item.seq === input.requestSeq)
      if (check === undefined || request === undefined || !/^[a-f0-9]{40}$/.test(input.commit)) throw new VerificationError('invalid-target')
      const checkRevision = verificationCheckRevision(check)
      const previous = state.targets.at(-1)
      if (previous?.request.seq === request.seq && previous.commit === input.commit && previous.checkRevision === checkRevision) {
        await flush()
        return previous
      }
      const record = { version: 1 as const, request, commit: input.commit, check, checkRevision }
      const seq = await append('plugin:mydot/verification-target', record)
      return { seq, request, commit: input.commit, check, checkRevision }
    })
  }

  /** Record an existing GitHub run for the caller's exact, still-selected target.
   * @param sessionId - Live or stored source Session; no Agent activation is required.
   * @param targetSeq - Selection observed by the caller; stale selections reject before I/O.
   * @param runId - Existing positive GitHub Actions run ID.
   * @param signal - Caller cancellation, combined with plugin disposal and deployment deadline.
   * @returns After the observation is durable; a newer target keeps this result as history.
   */
  @Remote({ resources: { session: sessionId => sessionId } })
  async refresh(sessionId: SessionId, targetSeq: SessionSeq, runId: number, signal: AbortSignal): Promise<void> {
    const operation = this.observeAndRefresh(sessionId, targetSeq, runId, signal)
    this.pending.add(operation)
    try { await operation } finally { this.pending.delete(operation) }
  }

  private async observeAndRefresh(sessionId: SessionId, targetSeq: SessionSeq, runId: number, signal: AbortSignal): Promise<void> {
    this.lifecycle.signal.throwIfAborted()
    using source = await this.ctx.sessionQuery.observeSession(sessionId, { signal: this.lifecycle.signal })
    const state = source.projections?.values.mydotEvidence
    const target = state?.targets.at(-1)
    if (target === undefined || target.seq !== targetSeq || !state?.requests.some(request => request.seq === target.request.seq)
      || !this.config.checks.some(check => check.id === target.check.id
      && verificationCheckRevision(check) === target.checkRevision)) throw new VerificationError('stale-target')
    if (!Number.isSafeInteger(runId) || runId < 1) throw new VerificationError('invalid-target')
    const previous = this.refreshing.get(sessionId) ?? Promise.resolve()
    const work = previous.catch(() => undefined).then(async () => {
      const lifetime = AbortSignal.any([signal, this.lifecycle.signal, AbortSignal.timeout(this.config.timeoutMs)])
      let result: VerificationResult
      try {
        lifetime.throwIfAborted()
        result = await readGitHubVerification(target, runId, (endpoint, active) => this.read(endpoint, active), lifetime)
      } catch (error: unknown) {
        result = { outcome: 'unavailable', reason: lifetime.aborted ? 'cancelled' : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid-response' : 'provider-unavailable' }
      }
      await this.withWriter(sessionId, async (writer) => {
        if (!sameSessionIdentity(writer.header, source.header)
          || !isDeepStrictEqual(writer.state.targets.find(candidate => candidate.seq === targetSeq), target)) {
          throw new VerificationError('stale-target')
        }
        await writer.append('plugin:mydot/verification-observation', { version: 1, targetSeq, observedAt: Date.now(), ...result })
      })
    })
    this.refreshing.set(sessionId, work)
    this.pending.add(work)
    try { await work } finally {
      this.pending.delete(work)
      if (this.refreshing.get(sessionId) === work) this.refreshing.delete(sessionId)
    }
  }

  private live(sessionId: SessionId): Session {
    this.lifecycle.signal.throwIfAborted()
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) throw new VerificationError('session-unavailable')
    return session
  }

  /** Serialize short compare/append transactions; external reads never hold a cold writer. */
  private withWriter<Value>(sessionId: SessionId, operation: (writer: EvidenceWriter) => Promise<Value>): Promise<Value> {
    const previous = this.writing.get(sessionId) ?? Promise.resolve()
    const work = previous.catch(() => undefined).then(async () => {
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) {
        const state = this.ctx.sessionProjections.stateOf(live, 'mydotEvidence')
        /* v8 ignore next -- the same registration effect drains every admitted writer before unregistering this projection. */
        if (state === undefined) throw new VerificationError('session-unavailable')
        return operation({ header: live.header, nextSeq: live.seq, state, flush: () => this.flush(live),
          append: async (type, data) => {
            const seq = appendPluginRecord(live, type, data)
            await this.flush(live)
            return seq
          } })
      }
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined || await persistence.stat(sessionId) === undefined) throw new VerificationError('session-unavailable')
      const handle = await persistence.open(sessionId, 'write')
      try {
        const { events } = await handle.read()
        let nextSeq = events.length
        const state = events.reduce(foldVerification, verificationProjection.init(handle.header, handle.inheritedEventCount))
        return await operation({ header: handle.header, nextSeq, state, flush: () => handle.flush(),
          append: async (type, data) => {
            const record = createPluginRecord(type, data, SessionSeq(nextSeq))
            await handle.append([record])
            nextSeq += 1
            await handle.flush()
            this.config.changed()
            return record.seq
          } })
      } finally { await handle.close() }
    })
    const done = work.finally(() => {
      this.pending.delete(done)
      if (this.writing.get(sessionId) === done) this.writing.delete(sessionId)
    })
    this.writing.set(sessionId, done)
    this.pending.add(done)
    return done
  }

  private flush(session: Session): Promise<void> {
    const through = session.seq - 1
    if (through <= (this.acknowledged.get(session) ?? -1)) return Promise.resolve()
    const previous = this.flushing.get(session)
    if (previous !== undefined && previous.through >= through) return previous.done
    const write = (previous?.done ?? Promise.resolve()).catch(() => undefined).then(async () => {
      using source = await this.ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
      if (source.source !== 'live' || source.header !== session.header || source.cursor < through) {
        throw new VerificationError('not-durable')
      }
      if (!await this.ctx.sessions.flush(session)) throw new VerificationError('not-durable')
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) throw new VerificationError('not-durable')
      const handle = await persistence.open(session.id, 'read')
      try {
        const { events } = await handle.read(through, 1)
        if (!sameSessionIdentity(handle.header, source.header) || !isDeepStrictEqual(events[0], source.events[through])) {
          throw new VerificationError('not-durable')
        }
      } finally { await handle.close() }
      this.acknowledged.set(session, Math.max(through, this.acknowledged.get(session) ?? -1))
      this.config.changed()
    })
    const done = write.finally(() => {
      this.pending.delete(done)
      if (this.flushing.get(session)?.done === done) this.flushing.delete(session)
    })
    this.flushing.set(session, { through, done })
    this.pending.add(done)
    return done
  }

  private async read(endpoint: string, signal: AbortSignal): Promise<unknown> {
    const executable = await this.ctx.subprocess.resolveExecutable('gh', undefined, signal)
    signal.throwIfAborted()
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, 'api', '--hostname', 'github.com', '--method', 'GET', endpoint],
      cwd: this.ctx.workingDirectory.defaultDirectory,
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.config.maxOutputBytes }, stderr: { maxBytes: this.config.maxOutputBytes } },
      graceMs: this.config.timeoutMs, signal,
    })
    const outcome = await handle.done
    signal.throwIfAborted()
    const output = handle.collected.stdout?.readFrom(0)
    if (outcome.exitCode !== 0 || output === undefined || output.lossy) throw new Error('GitHub evidence could not be read')
    return JSON.parse(output.text)
  }
}
