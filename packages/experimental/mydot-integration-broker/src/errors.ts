/** Sanitized failures shared by broker admission, persistence and provider adapters. */

import type { BrokerFailure } from './types.ts'

/** A caller-actionable failure that never contains a provider response or secret. */
export class BrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly outcome: 'not_started' | 'unknown' = 'not_started',
  ) { super(message) }
}

/**
 * Remove implementation and provider details from an error returned over HTTP.
 * @param error - Failure caught at the broker boundary.
 * @returns Stable failure fields; unexpected failures require operator inspection.
 */
export function failure(error: unknown): BrokerFailure {
  return {
    version: 1,
    ok: false,
    error: error instanceof BrokerError
      ? { code: error.code, message: error.message, outcome: error.outcome, retryable: false }
      : { code: 'internal_error', message: 'The broker could not complete this request. Check broker health before continuing.', outcome: 'unknown', retryable: false },
  }
}
