/** Validated experimental Session records and their incremental verification projection. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { pluginRecordOf, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { readJobRequest } from './job-request.ts'
import type { VerificationCheck, VerificationCheckId, VerificationObservation, VerificationRequest, VerificationTarget, VerificationView } from './verification-types.ts'

/** Validated configured condition; the workflow blob fixes the reviewed checkout semantics. */
export const verificationCheckSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).transform(value => brandString<VerificationCheckId>(value)),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(value => !value.split('/').some(part => part === '.' || part === '..')),
  workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
  workflowFileSha: z.string().regex(/^[a-f0-9]{40}$/),
  jobName: z.string().min(1),
  description: z.string().min(1),
})
const seq = z.number().int().nonnegative().transform(SessionSeq)
const requestSchema = z.object({ seq, text: z.string() })
const targetSchema = z.object({
  seq, request: requestSchema, commit: z.string().regex(/^[a-f0-9]{40}$/),
  check: verificationCheckSchema, checkRevision: z.string().regex(/^[a-f0-9]{64}$/),
})
const observationSchema = z.object({
  seq, targetSeq: seq, observedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  outcome: z.enum(['passed', 'failed', 'unavailable']),
  reason: z.enum(['condition-passed', 'condition-failed', 'job-not-completed', 'job-not-passed', 'job-missing',
    'job-ambiguous', 'run-mismatch', 'unsupported-event', 'workflow-changed', 'attempt-changed', 'provider-unavailable', 'invalid-response', 'cancelled']),
  run: z.object({ id: z.number().int().positive(), attempt: z.number().int().positive(),
    url: z.string(), commit: z.string(), event: z.string() }).optional(),
  job: z.object({ id: z.number().int().positive(), url: z.string(), name: z.string(), conclusion: z.string().nullable() }).optional(),
})

/** Payload of the user's immutable target selection, excluding its Session envelope. */
export type VerificationTargetRecord = { version: 1 } & Omit<VerificationTarget, 'seq'>
/** Payload of the Host-owned CI read, excluding its Session envelope. */
export type VerificationObservationRecord = { version: 1 } & Omit<VerificationObservation, 'seq'>
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Explicit MyDot request, condition revision and commit selection. */
    'plugin:mydot/verification-target': VerificationTargetRecord
    /** CI result observed by the Host for one immutable selection. */
    'plugin:mydot/verification-observation': VerificationObservationRecord
  }
}

/** JSON projection state; inherited parent records are never attributed to a new child. */
export interface VerificationState {
  inheritedEventCount: number
  requests: VerificationRequest[]
  targets: VerificationTarget[]
  observations: VerificationObservation[]
  invalidRecords: boolean
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { mydotEvidence: VerificationState }
  interface SessionProjectionMap { mydotEvidence: VerificationState }
}

/** Digest of all fields that determine the meaning of a configured check.
 * @param check - Validated deployment definition.
 * @returns Immutable condition version used for equality, never an external CI verdict.
 */
export function verificationCheckRevision(check: VerificationCheck): string {
  return createHash('sha256').update(JSON.stringify([1, check.id, check.repository, check.workflowPath,
    check.workflowFileSha, check.jobName, check.description])).digest('hex')
}

function invalid(state: VerificationState): VerificationState { return state.invalidRecords ? state : { ...state, invalidRecords: true } }

/** Fold one committed event without interpreting assistant prose as a CI result.
 * @param state - State of preceding events in this Session.
 * @param event - Next committed event.
 * @returns Updated state, or the original reference for unrelated events.
 */
export function foldVerification(state: VerificationState, event: SessionEvent): VerificationState {
  if (event.seq < state.inheritedEventCount) return state
  if (event.type === 'user/message' && event.data.source.kind === 'user') {
    const blocks = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    const text = blocks.map(readJobRequest).find(value => value !== undefined) ?? blocks.join('\n')
    const replaced = typeof event.surfaceOp === 'object' ? event.surfaceOp : undefined
    const requests = replaced === undefined ? state.requests
      : state.requests.filter(request => request.seq < replaced.startSeq || request.seq > replaced.endSeq)
    if (text.trim() === '') return requests === state.requests ? state : { ...state, requests }
    return { ...state, requests: [...requests, { seq: event.seq, text }] }
  }
  const record = pluginRecordOf(event)
  if (record?.type === 'plugin:mydot/verification-target') {
    const parsed = targetSchema.extend({ version: z.literal(1) }).safeParse({ ...recordObject(record.data), seq: record.seq })
    if (!parsed.success) return invalid(state)
    const { version: _version, ...target } = parsed.data
    if (target.request.seq >= record.seq
      || !state.requests.some(request => request.seq === target.request.seq && request.text === target.request.text)
      || target.checkRevision !== verificationCheckRevision(target.check)) return invalid(state)
    return { ...state, targets: [...state.targets, target] }
  }
  if (record?.type === 'plugin:mydot/verification-observation') {
    const parsed = observationSchema.extend({ version: z.literal(1) }).safeParse({ ...recordObject(record.data), seq: record.seq })
    if (!parsed.success) return invalid(state)
    const { version: _version, ...observation } = parsed.data
    const target = state.targets.find(value => value.seq === observation.targetSeq)
    if (target === undefined || target.seq >= record.seq || !validObservation(target, observation)) return invalid(state)
    return { ...state, observations: [...state.observations, observation] }
  }
  return state
}

function recordObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function validObservation(target: VerificationTarget, observation: VerificationObservation): boolean {
  const { run, job } = observation
  if (run !== undefined && run.url !== `https://github.com/${target.check.repository}/actions/runs/${run.id}/attempts/${run.attempt}`) return false
  if (job !== undefined && (run === undefined || job.url !== `https://github.com/${target.check.repository}/actions/runs/${run.id}/job/${job.id}`)) return false
  if (observation.outcome === 'unavailable') return observation.reason !== 'condition-passed' && observation.reason !== 'condition-failed'
  if (run === undefined || job === undefined || run.commit !== target.commit || job.name !== target.check.jobName
    || (run.event !== 'push' && run.event !== 'merge_group')) return false
  return observation.outcome === 'passed'
    ? observation.reason === 'condition-passed' && job.conclusion === 'success'
    : observation.reason === 'condition-failed' && (job.conclusion === 'failure' || job.conclusion === 'timed_out')
}

/** Incremental host and read-only wire projection registered only when checks are configured. */
export const verificationProjection: ProjectionDefinition<'mydotEvidence'> & Required<Pick<ProjectionDefinition<'mydotEvidence'>, 'wire'>> = {
  key: 'mydotEvidence', stateVersion: 1,
  stateSchema: z.object({ inheritedEventCount: z.number().int().nonnegative(), requests: z.array(requestSchema),
    targets: z.array(targetSchema), observations: z.array(observationSchema), invalidRecords: z.boolean() }),
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, requests: [], targets: [], observations: [], invalidRecords: false }),
  apply: foldVerification,
  wire: {
    viewSchema: z.object({ inheritedEventCount: z.number().int().nonnegative(), requests: z.array(requestSchema),
      targets: z.array(targetSchema), observations: z.array(observationSchema), invalidRecords: z.boolean() }),
    view: state => state,
  },
}

/** Resolve currentness against the selected request and current deployment definitions.
 * @param state - The registered Session projection.
 * @param checks - Currently enabled deployment definitions.
 * @returns Scoped current status and retained historical observations.
 */
export function verificationView(state: VerificationState, checks: readonly VerificationCheck[]): VerificationView {
  const target = state.targets.at(-1) ?? null
  const definitionCurrent = target !== null
    && state.requests.some(request => request.seq === target.request.seq && request.text === target.request.text)
    && checks.some(check => check.id === target.check.id && verificationCheckRevision(check) === target.checkRevision)
  const history = state.observations.flatMap((observation) => {
    const source = state.targets.find(value => value.seq === observation.targetSeq)
    return source === undefined ? [] : [{ target: source, observation, current: definitionCurrent && source.seq === target.seq }]
  })
  const latest = history.filter(item => item.current).at(-1)
  return { requests: state.requests, target, definitionCurrent, history, invalidRecords: state.invalidRecords,
    status: state.invalidRecords ? 'unavailable' : latest?.observation.outcome ?? 'unobserved' }
}
