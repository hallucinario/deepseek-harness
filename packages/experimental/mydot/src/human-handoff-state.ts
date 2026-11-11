/** Validation and Session projection for durable MyDot human dependencies. */
import { z } from 'zod'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { HumanAnswer, HumanRequestId, HumanRequestView, HumanSubmissionId, PreparedHumanRequest, SurveyHandoffResult } from './types.ts'

/** Shared request identity accepted by the drawing application and callback path. */
export const humanRequestIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/).transform(value => value as HumanRequestId)
const requestId = humanRequestIdSchema
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const identity = z.string().min(1)
const surveyIdentity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
/** Exact immutable source and starting edit coordinates carried by the review link. */
export const humanSurveyTargetSchema = z.object({ caseId: surveyIdentity, sourceId: surveyIdentity, sourceRevision: sha256,
  baseRevisionId: sha256, baseVersion: revision, workflow: z.enum(['independent-reference', 'assisted-correction']) }).strict()
const evidenceUrl = z.string().refine((value) => {
  if (value === '') return true
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.searchParams.has('token') }
  catch (_error: unknown) { return false }
}, 'Use a non-secret HTTP or HTTPS link')

/** Exact server-generated survey reference accepted over the local process boundary. */
export const surveyResultSchema: z.ZodType<SurveyHandoffResult> = z.object({
  schemaVersion: z.literal(1), requestId, status: z.enum(['saved', 'applied', 'deferred', 'needs-material']),
  source: z.object({ caseId: surveyIdentity, sourceId: surveyIdentity, sourceRevision: sha256, manifestId: sha256 }).strict(),
  baseSurvey: z.object({ revisionId: sha256, version: revision }).strict(),
  survey: z.object({ revisionId: sha256, version: revision }).strict(),
  planning: z.object({ caseId: surveyIdentity, revisionId: identity.max(160),
    headVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().nullable(),
  goldId: sha256.nullable(),
}).strict()

/** Prepared source, responder role and original branch recovered from Session storage. */
export const humanRequestSchema: z.ZodType<PreparedHumanRequest> = z.object({
  requestId, requestRevision: revision, sessionId: identity.transform(SessionId), parentSessionId: identity.transform(SessionId).nullable(),
  question: identity, reason: identity, role: z.literal('owner'), evidenceUrl, resumeInstruction: identity, options: z.array(identity),
  target: humanSurveyTargetSchema.nullable(),
  goal: z.object({ id: identity, revision, roundsStarted: z.number().int().nonnegative(), armed: z.boolean() }).strict().nullable(),
}).strict()

/** Stable submission identity and explicit disposition from a real answer operation. */
export const humanAnswerSchema: z.ZodType<HumanAnswer> = z.object({
  requestId, requestRevision: revision,
  submissionId: identity.transform(value => value as HumanSubmissionId), choice: identity,
  text: z.string(), result: surveyResultSchema.nullable(),
}).strict()

const viewSchema: z.ZodType<HumanRequestView> = z.object({
  request: humanRequestSchema, phase: z.enum(['pending', 'received', 'dispatching', 'queued', 'claimed', 'resumed', 'stopped', 'retired', 'outcome']),
  answer: humanAnswerSchema.optional(), rpcId: z.string().optional(), reason: z.string().optional(),
  outcome: z.enum(['succeeded', 'failed', 'unknown']).optional(), evidence: z.string().optional(),
}).strict()

/** Fold only correlated durable events; inactivity cannot complete a request.
 * @param state - Previous request views in prepare order.
 * @param event - One committed Session event.
 * @returns Next immutable views, retaining unrelated requests.
 */
export function applyHumanRequestEvent(state: readonly HumanRequestView[], event: SessionEvent): readonly HumanRequestView[] {
  if (event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source) {
    const rpcId = event.data.source.rpcId
    return state.map(view => view.rpcId === rpcId && view.phase !== 'outcome' && view.phase !== 'retired' ? { ...view, phase: 'resumed' } : view)
  }
  if (event.type !== 'mydot/human-handoff') return state
  const change = event.data
  if (change.kind === 'prepared') {
    const request = humanRequestSchema.parse(change.request)
    return [...state.filter(view => view.request.requestId !== request.requestId), { request, phase: 'pending' }]
  }
  return state.map((view) => {
    if (view.request.requestId !== change.requestId) return view
    if (view.phase === 'retired' || view.phase === 'outcome') return view
    switch (change.kind) {
      case 'received': return { ...view, answer: humanAnswerSchema.parse(change.answer), phase: 'received' }
      case 'dispatching': return { ...view, rpcId: change.rpcId, phase: 'dispatching' }
      case 'queued': return view.phase === 'resumed' || view.phase === 'claimed' || view.phase === 'stopped' ? view : { ...view, phase: 'queued' }
      case 'claimed': return view.phase === 'resumed' || view.phase === 'stopped' ? view : { ...view, phase: 'claimed' }
      case 'resumed': return { ...view, phase: 'resumed' }
      case 'stopped': return { ...view, phase: 'stopped', reason: change.reason }
      case 'retired': return { ...view, phase: 'retired', reason: change.reason }
      case 'outcome': return { ...view, phase: 'outcome', outcome: change.outcome, evidence: change.evidence }
    }
  })
}

/** One canonical Host computation and Client wire view for request state. */
export const humanRequestProjection = {
  key: 'mydotHumanRequests', stateSchema: z.array(viewSchema).readonly(), init: () => [],
  apply: applyHumanRequestEvent,
  wire: { viewSchema: z.array(viewSchema).readonly(), view: state => state }, stateVersion: 1,
} satisfies ProjectionDefinition<'mydotHumanRequests', readonly HumanRequestView[]>
