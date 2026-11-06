/** Strict parsers for model input, administrative input and encrypted durable records. */

import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { BrokerError } from './errors.ts'
import type { BrokerRequest, ConnectionId, RequestId, ResourceId } from './types.ts'

const id = z.string().min(1).max(1024).refine(value => !/[\u0000-\u001f\u007f]/u.test(value))
const connectionId = id.transform(brandString<ConnectionId>)
const resourceId = id.transform(brandString<ResourceId>)
const requestId = z.uuid().transform(brandString<RequestId>)
const timestamp = z.iso.datetime({ offset: true })
const recipients = z.array(z.email().max(320)).max(100)
const event = {
  subject: z.string().min(1).max(1000),
  body: z.string().max(32_000).optional(),
  location: z.string().max(1000).optional(),
  start: timestamp,
  end: timestamp,
}
const draft = {
  subject: z.string().max(1000),
  body: z.string().max(64_000),
  to: recipients,
  cc: recipients.optional(),
  bcc: recipients.optional(),
}
const etag = z.string().min(1).max(1024).refine(value => !/[\r\n]/u.test(value))
const page = { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(32_000).optional() }
const argumentSchemas = {
  'connections.list': z.strictObject({}),
  'resources.list': z.strictObject({}),
  'calendar.list': z.strictObject({ start: timestamp, end: timestamp, ...page }),
  'calendar.get': z.strictObject({ eventId: id }),
  'calendar.create': z.strictObject(event),
  'calendar.update': z.strictObject({ ...z.object(event).partial().shape, eventId: id, etag }),
  'calendar.delete': z.strictObject({ eventId: id, etag }),
  'mail.list': z.strictObject({ query: z.string().max(500).optional(), ...page }),
  'mail.get': z.strictObject({ messageId: id }),
  'mail.createDraft': z.strictObject(draft),
  'mail.updateDraft': z.strictObject({ ...z.object(draft).partial().shape, messageId: id, etag }),
  'mail.replyDraft': z.strictObject({ messageId: id, body: draft.body, replyAll: z.boolean().optional() }),
  'mail.forwardDraft': z.strictObject({ messageId: id, body: draft.body, to: recipients }),
  'mail.organize': z.strictObject({ messageId: id, etag, categories: z.array(z.string().min(1).max(255)).max(25).optional(), flag: z.enum(['notFlagged', 'flagged', 'complete']).optional() }),
}
const operationSchema = z.enum(Object.keys(argumentSchemas) as [keyof typeof argumentSchemas, ...(keyof typeof argumentSchemas)[]])
const envelope = z.strictObject({
  version: z.literal(1), sessionId: id, operation: operationSchema,
  connectionId: connectionId.optional(), resourceId: resourceId.optional(), requestId: requestId.optional(), arguments: z.unknown(),
})

/**
 * Admit only the fixed operation vocabulary and its exact argument fields.
 * @param value - Untrusted JSON received from the authenticated Host.
 * @returns Validated, branded operation request.
 */
export function parseRequest(value: unknown): BrokerRequest {
  const parsed = envelope.safeParse(value)
  if (!parsed.success) throw new BrokerError('invalid_request', 'Use a supported operation and its documented fields.')
  const args = argumentSchemas[parsed.data.operation].safeParse(parsed.data.arguments)
  if (!args.success) throw new BrokerError('invalid_arguments', 'The operation arguments contain invalid or unsupported fields.')
  if (parsed.data.operation !== 'connections.list' && parsed.data.connectionId === undefined) {
    throw new BrokerError('account_required', 'Select an explicit connection; no default account is used.')
  }
  if (!['connections.list', 'resources.list'].includes(parsed.data.operation) && parsed.data.resourceId === undefined) {
    throw new BrokerError('resource_required', 'Select an explicit calendar or mailbox.')
  }
  if (isMutation(parsed.data.operation) && parsed.data.requestId === undefined) {
    throw new BrokerError('request_id_required', 'A stable request identifier is required for every change.')
  }
  if ('start' in args.data && 'end' in args.data) {
    if (Date.parse(args.data.end) <= Date.parse(args.data.start)) throw new BrokerError('invalid_time_range', 'End must follow start.')
    if (parsed.data.operation === 'calendar.list' && Date.parse(args.data.end) - Date.parse(args.data.start) > 366 * 86_400_000) {
      throw new BrokerError('range_too_large', 'Read at most 366 days in one calendar query.')
    }
  }
  return { ...parsed.data, arguments: args.data } as BrokerRequest
}

/**
 * Determine whether an admitted operation needs a durable mutation journal entry.
 * @param operation - Supported operation name.
 * @returns Whether the operation changes provider data.
 */
export function isMutation(operation: keyof typeof argumentSchemas): boolean {
  return !['connections.list', 'resources.list', 'calendar.list', 'calendar.get', 'mail.list', 'mail.get'].includes(operation)
}

/** Capability parser reused by connection policies and Session grants. */
export const capabilitySchema = z.enum(['calendar.read', 'calendar.write', 'mail.read', 'mail.draft', 'mail.organize'])
/** Explicit per-resource permission; empty capabilities leave the resource inaccessible. */
export const resourcePolicySchema = z.strictObject({
  id: resourceId, label: z.string().max(1000), capabilities: z.array(capabilitySchema).max(5),
})
/** Human-managed Session permission; no wildcard or implicit child inheritance is accepted. */
export const grantSchema = z.strictObject({
  sessionId: id, connectionId, resources: z.array(resourceId).max(200),
  capabilities: z.array(capabilitySchema).max(5), expiresAt: z.number().int().positive(),
})
/** Persisted account metadata and encrypted provider credentials. */
export const connectionSchema = z.strictObject({
  id: connectionId, provider: z.enum(['google', 'microsoft']), subject: id, label: z.string().min(1).max(1000),
  email: z.string().max(320), scopes: z.array(z.string().max(512)).max(50), enabled: z.boolean(),
  resources: z.array(resourcePolicySchema).max(200),
  credentials: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('google'), refreshToken: z.string().min(1).max(16_000) }),
    z.strictObject({ kind: z.literal('microsoft'), cache: z.string().min(1).max(2_000_000), homeAccountId: id }),
  ]),
})
/** Encrypted state version. Changes require an explicit migration. */
export const stateSchema = z.strictObject({
  version: z.literal(1), connections: z.array(connectionSchema).max(64), grants: z.array(grantSchema).max(1000),
})
/** Persisted connection type inferred from its parser. */
export type Connection = z.infer<typeof connectionSchema>
/** In-memory state owned by one broker. */
export type State = z.infer<typeof stateSchema>

/** Durable operation receipts are revalidated after authenticated decryption. */
export const responseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    version: z.literal(1), ok: z.literal(true), operation: operationSchema,
    connectionId: connectionId.optional(), resourceId: resourceId.optional(), requestId: requestId.optional(),
    accountLabel: z.string().optional(), data: z.json(), nextCursor: z.string().optional(), warnings: z.array(z.string()),
  }),
  z.strictObject({ version: z.literal(1), ok: z.literal(false), error: z.strictObject({ code: z.string(), message: z.string(), outcome: z.enum(['not_started', 'unknown']), retryable: z.literal(false) }) }),
])
