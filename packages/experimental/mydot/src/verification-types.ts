/** Browser-safe references to explicitly selected CI conditions and Session evidence. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Deployment-owned identity of one CI condition. */
export type VerificationCheckId = Branded<'MyDotVerificationCheckId'>

/** Reviewed workflow whose push and merge-group source checkout and job semantics are known. */
export interface VerificationCheck {
  /** Deployment-owned stable condition identifier. */
  id: VerificationCheckId
  /** GitHub repository in owner/name form. */
  repository: string
  /** Reviewed workflow path within .github/workflows. */
  workflowPath: string
  /** Git blob SHA of the reviewed workflow with an unmodified default source checkout. */
  workflowFileSha: string
  /** Exact job name whose conclusion constitutes this condition. */
  jobName: string
  /** User-visible explanation of what this condition establishes. */
  description: string
}

/** One local user message, independent of subsequent conversation turns. */
export interface VerificationRequest { seq: SessionSeq; text: string }

/** User selection; conclusions are supplied only by the Host's CI reader. */
export interface VerificationTargetInput { requestSeq: SessionSeq; checkId: VerificationCheckId; commit: string }

/** Immutable condition and request bound to a particular repository commit. */
export interface VerificationTarget {
  seq: SessionSeq
  request: VerificationRequest
  commit: string
  check: VerificationCheck
  checkRevision: string
}

/** GitHub's current workflow attempt, without claiming that a mutable worktree was tested. */
export interface VerificationRun { id: number; attempt: number; url: string; commit: string; event: string }

/** One exact CI job from the recorded workflow attempt. */
export interface VerificationJob { id: number; url: string; name: string; conclusion: string | null }

/** Stable reason codes displayed through the Client's locale dictionaries. */
export type VerificationReason = 'condition-passed' | 'condition-failed' | 'job-not-completed' | 'job-not-passed'
  | 'job-missing' | 'job-ambiguous' | 'run-mismatch' | 'unsupported-event' | 'workflow-changed'
  | 'attempt-changed' | 'provider-unavailable' | 'invalid-response' | 'cancelled'

/** A persisted observation; an unsuccessful read is evidence of uncertainty, never success. */
export interface VerificationObservation {
  seq: SessionSeq
  targetSeq: SessionSeq
  observedAt: number
  outcome: 'passed' | 'failed' | 'unavailable'
  reason: VerificationReason
  run?: VerificationRun | undefined
  job?: VerificationJob | undefined
}

/** A historical observation retains the original target even after selection changes. */
export interface VerificationHistory { target: VerificationTarget; observation: VerificationObservation; current: boolean }

/** Projection consumed by MyDot; missing, invalid, and stale observations never pass. */
export interface VerificationView {
  requests: VerificationRequest[]
  target: VerificationTarget | null
  status: 'unobserved' | 'passed' | 'failed' | 'unavailable'
  definitionCurrent: boolean
  history: VerificationHistory[]
  invalidRecords: boolean
}
