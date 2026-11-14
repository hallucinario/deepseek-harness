/** Strict durable/wire decoding and one canonical filing projection. */
import { z } from 'zod'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { FilingCaseId, FilingPlan, FilingView, MockReceipt, RecorderStatus } from './filing-types.ts'
const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().trim().min(1)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Exact synthetic submission plan; model supplied digests still require current-file verification. */
export const filingPlanSchema: z.ZodType<FilingPlan> = z.object({
  caseId: identity.transform(value => value as FilingCaseId), legalEntity: text, account: identity,
  site: z.literal('local-synthetic-recipient'), period: z.object({ from: z.iso.date(), to: z.iso.date() }).strict()
    .refine(value => value.from <= value.to, 'Invalid filing period'), tax: identity,
  destination: z.literal('mock-local'), amount: z.string().regex(/^(0|[1-9][0-9]*)$/), currency: z.literal('JPY'),
  forms: z.array(identity).min(1), files: z.array(z.object({ role: z.enum(['source', 'preview', 'attachment']), path: text, digest }).strict())
    .refine(files => files.some(file => file.role === 'source') && files.some(file => file.role === 'preview'), 'Source and preview are required'),
  inputDestinations: z.array(identity), modelDestinations: z.array(identity), expiresAt: time,
  stopRef: identity, queryRef: identity,
  effects: z.object({ submit: z.boolean(), payment: z.enum(['none', 'one-time']), standingSettings: z.enum(['none', 'auto-debit']) }).strict(),
}).strict()
/** Independent recorder response; unknown fields, including secret contents, are rejected. */
export const recorderStatusSchema: z.ZodType<RecorderStatus> = z.object({
  version: z.literal('high-impact-recorder/v1'), caseId: identity, planDigest: digest,
  state: z.enum(['starting', 'recording', 'protected', 'failed', 'stopped']), evidence: z.enum(['complete', 'partial', 'unavailable']),
  readyForConfirmation: z.boolean(), sequence: time, observedAt: time, archiveRef: identity,
  segments: z.array(identity), protectedIntervals: z.array(identity), gaps: z.array(identity),
}).strict()
/** Receipt wire identity must match the stable intent and exact reviewed forms. */
export const mockReceiptSchema: z.ZodType<MockReceipt> = z.object({ receiptId: identity, intentId: identity,
  caseId: identity.transform(value => value as FilingCaseId), planDigest: digest, forms: z.array(identity).min(1) }).strict()
/** Durable complete state rejects unrecognized secret-bearing fields. */
export const filingViewSchema: z.ZodType<FilingView> = z.object({
  sessionId: text.transform(SessionId), plan: filingPlanSchema, previousPlan: filingPlanSchema.optional(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), planDigest: digest,
  phase: z.enum(['prepared', 'approved', 'intent', 'unknown', 'accepted', 'cancelled', 'invalidated']),
  actor: z.enum(['model-preparer', 'host-owner']), control: z.enum(['agent', 'stopping', 'human', 'return-authorized']), intentId: identity.optional(), recorder: recorderStatusSchema.optional(),
  ownerControlConfirmation: z.object({ revision: z.number().int().positive(), planDigest: digest, confirmedAt: time, source: z.literal('host-owner') }).strict().optional(),
  receipt: mockReceiptSchema.optional(), reason: z.enum(['files-changed', 'confirmation-unknown', 'owner-cancelled', 'persistence-unconfirmed']).optional(),
}).strict()
/** Apply only validated filing records in their original Session.
 * @param state - Prior immutable filing views.
 * @param event - Committed Session event.
 * @returns Updated view list or unchanged unrelated state.
 */
export function applyFilingEvent(state: readonly FilingView[], event: SessionEvent): readonly FilingView[] {
  if (event.type !== 'mydot/filing') return state
  const view = filingViewSchema.parse(event.data.view)
  return [...state.filter(item => item.plan.caseId !== view.plan.caseId), view]
}
/** Host and Client share the same validated projection. */
export const filingProjection = { key: 'mydotFilings', init: () => [], stateSchema: z.array(filingViewSchema).readonly(),
  apply: applyFilingEvent, wire: { viewSchema: z.array(filingViewSchema).readonly(), view: state => state }, stateVersion: 1,
} satisfies ProjectionDefinition<'mydotFilings', readonly FilingView[]>
