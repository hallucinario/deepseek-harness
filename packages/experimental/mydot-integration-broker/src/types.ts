/** JSON protocol shared by the isolated broker and its authenticated Harness client. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable broker identity; email addresses are display metadata only. */
export type ConnectionId = Branded<'MyDotConnectionId'>
/** Provider resource identifier, always qualified by a connection. */
export type ResourceId = Branded<'MyDotResourceId'>
/** Mutation identity scoped to a connection and originating Session. */
export type RequestId = Branded<'MyDotRequestId'>
/** Providers supported by the broker. */
export type Provider = 'google' | 'microsoft'
/** Independently revocable permissions within an OAuth grant. */
export type Capability = 'calendar.read' | 'calendar.write' | 'mail.read' | 'mail.draft' | 'mail.organize'
/** Closed operation set. Sending, meeting actions and generic HTTP are absent. */
export type Operation = 'connections.list' | 'resources.list' | 'calendar.list' | 'calendar.get'
  | 'calendar.create' | 'calendar.update' | 'calendar.delete' | 'mail.list' | 'mail.get'
  | 'mail.createDraft' | 'mail.updateDraft' | 'mail.replyDraft' | 'mail.forwardDraft' | 'mail.organize'
/** Bounded JSON returned by providers; content is untrusted data, never instructions. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
/** Typed operation arguments accepted at the broker wire parser. */
export interface OperationArguments {
  'connections.list': Record<string, never>
  'resources.list': Record<string, never>
  'calendar.list': { start: string; end: string; limit?: number; cursor?: string }
  'calendar.get': { eventId: string }
  'calendar.create': { subject: string; body?: string; location?: string; start: string; end: string }
  'calendar.update': { eventId: string; etag: string; subject?: string; body?: string; location?: string; start?: string; end?: string }
  'calendar.delete': { eventId: string; etag: string }
  'mail.list': { query?: string; limit?: number; cursor?: string }
  'mail.get': { messageId: string }
  'mail.createDraft': { subject: string; body: string; to: string[]; cc?: string[]; bcc?: string[] }
  'mail.updateDraft': { messageId: string; etag: string; subject?: string; body?: string; to?: string[]; cc?: string[]; bcc?: string[] }
  'mail.replyDraft': { messageId: string; body: string; replyAll?: boolean }
  'mail.forwardDraft': { messageId: string; body: string; to: string[] }
  'mail.organize': { messageId: string; etag: string; categories?: string[]; flag?: 'notFlagged' | 'flagged' | 'complete' }
}
/** Authenticated Host request. Session identity must come from the running agent, never tool JSON. */
export type BrokerRequest = {
  [K in Operation]: {
    version: 1
    sessionId: string
    operation: K
    connectionId?: ConnectionId
    resourceId?: ResourceId
    requestId?: RequestId
    arguments: OperationArguments[K]
  }
}[Operation]
/** One resource permission within a connection. */
export interface ResourcePolicy {
  id: ResourceId
  label: string
  capabilities: Capability[]
}
/** Human-created, expiring permission for one exact Session and account. */
export interface SessionGrant {
  sessionId: string
  connectionId: ConnectionId
  resources: ResourceId[]
  capabilities: Capability[]
  expiresAt: number
}
/** Display-safe connection projected after Session permission filtering. */
export interface ConnectionSummary {
  connectionId: ConnectionId
  provider: Provider
  label: string
  resources: ResourcePolicy[]
}
/** Successful response; provider text must remain labeled as external untrusted content. */
export interface BrokerSuccess {
  version: 1
  ok: true
  operation: Operation
  connectionId?: ConnectionId
  resourceId?: ResourceId
  requestId?: RequestId
  accountLabel?: string
  data: JsonValue
  nextCursor?: string
  warnings: string[]
}
/** Stable denial and unknown-outcome reports without OAuth tokens or raw provider errors. */
export interface BrokerFailure {
  version: 1
  ok: false
  error: {
    code: string
    message: string
    outcome: 'not_started' | 'unknown'
    retryable: false
  }
}
/** Broker response envelope. */
export type BrokerResponse = BrokerSuccess | BrokerFailure
