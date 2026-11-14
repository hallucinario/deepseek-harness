/** Browser-safe filing plans and durable owner decisions; no credential contents. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
/** Identity minted before preparing any filing work. */
export type FilingCaseId = Branded<'MyDotFilingCaseId'>
/** Immutable document observation, rechecked before an owner decision. */
export interface FilingFile { role: 'source' | 'preview' | 'attachment'; path: string; digest: string }
/** Exact effects and destinations reviewed by the owner. */
export interface FilingPlan {
  caseId: FilingCaseId
  legalEntity: string
  account: string
  site: 'local-synthetic-recipient'
  period: { from: string; to: string }
  tax: string
  destination: 'mock-local'
  amount: string
  currency: 'JPY'
  forms: string[]
  files: FilingFile[]
  inputDestinations: string[]
  modelDestinations: string[]
  expiresAt: number
  stopRef: string
  queryRef: string
  effects: { submit: boolean; payment: 'none' | 'one-time'; standingSettings: 'none' | 'auto-debit' }
}
/** Independent host observation; all recording details are opaque references. */
export interface RecorderStatus {
  version: 'high-impact-recorder/v1'
  caseId: string
  planDigest: string
  state: 'starting' | 'recording' | 'protected' | 'failed' | 'stopped'
  evidence: 'complete' | 'partial' | 'unavailable'
  readyForConfirmation: boolean
  sequence: number
  observedAt: number
  archiveRef: string
  segments: string[]
  protectedIntervals: string[]
  gaps: string[]
}
/** Synthetic recipient identity, checked independently of the owner button result. */
export interface MockReceipt { receiptId: string; intentId: string; caseId: FilingCaseId; planDigest: string; forms: string[] }
/** Durable state reconstructed from the original Session; authority never comes from a model answer. */
export interface FilingView {
  sessionId: SessionId
  plan: FilingPlan
  previousPlan?: FilingPlan | undefined
  revision: number
  planDigest: string
  phase: 'prepared' | 'approved' | 'intent' | 'unknown' | 'accepted' | 'cancelled' | 'invalidated'
  actor: 'model-preparer' | 'host-owner'
  control: 'agent' | 'stopping' | 'human' | 'return-authorized'
  ownerControlConfirmation?: { revision: number; planDigest: string; confirmedAt: number; source: 'host-owner' } | undefined
  intentId?: string | undefined
  recorder?: RecorderStatus | undefined
  receipt?: MockReceipt | undefined
  reason?: 'files-changed' | 'confirmation-unknown' | 'owner-cancelled' | 'persistence-unconfirmed' | undefined
}
/** Runtime readiness is never inferred from a persisted intent after restart. */
export interface FilingCardView { filing: FilingView; confirmationReady: boolean }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable filing plan, owner decision, intent and independently verified mock receipt. */
    'mydot/filing-case': { caseId: FilingCaseId; sessionId: SessionId }
    /** Complete current filing state, retained independently of its tool result. */
    'mydot/filing': { view: FilingView }
    /** Synthetic acceptance, persisted before returning any callback; contains no real transmission. */
    'mydot/mock-receipt': MockReceipt
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { mydotFilings: readonly FilingView[] }
  interface SessionProjectionStateMap { mydotFilings: readonly FilingView[] }
}
