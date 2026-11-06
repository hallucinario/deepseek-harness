/** Fixed provider origins, bounded responses and authenticated pagination without arbitrary URLs. */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { BrokerError } from './errors.ts'
import type { Connection } from './schema.ts'
import type { BrokerRequest, JsonValue } from './types.ts'

/** Provider response with JSON fields validated at the HTTP boundary. */
export type ProviderObject = { [key: string]: JsonValue }
/** Bounded provider read or write result, optionally carrying an opaque continuation. */
export interface ProviderResult { data: JsonValue; nextCursor?: string }

/**
 * Encode a provider identifier as one path segment, rejecting URL dot segments.
 * @param value - Provider identifier, never an endpoint or URL.
 * @returns Encoded, nonempty path segment.
 */
export function segment(value: string): string {
  if (value === '' || value === '.' || value === '..' || /[\u0000-\u001f\u007f]/u.test(value)) throw new BrokerError('invalid_identifier', 'Use an identifier returned by the selected provider.')
  return encodeURIComponent(value)
}

/**
 * Require a JSON object from a provider resource or nested property.
 * @param value - Parsed provider value.
 * @returns Its object fields, or a sanitized provider-data failure.
 */
export function object(value: JsonValue | undefined): ProviderObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BrokerError('provider_data_invalid', 'The provider returned incomplete resource metadata.', 502)
  return value
}

/**
 * Read one complete response within a byte bound, cancelling its stream on overflow.
 * @param response - Upstream response with an owned body stream.
 * @param maxBytes - Maximum response body bytes.
 * @returns UTF-8 response text.
 */
export async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new BrokerError('response_too_large', 'Narrow the query or reduce its page size.', 413)
      }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

/** One request's provider client; access tokens never leave this object. */
export class ProviderHttp {
  /** Whether any mutation request has been handed to the upstream transport. */
  mutationStarted = false
  private token: Promise<string> | undefined

  constructor(
    readonly connection: Connection,
    private readonly accessToken: () => Promise<string>,
    private readonly signal: AbortSignal,
    private readonly maxBytes: number,
    private readonly cursorKey: Buffer,
    private readonly transport: typeof fetch = fetch,
    private readonly assertPermission: () => void = () => {},
  ) {}

  /**
   * Execute an adapter-owned endpoint, rejecting redirects and every non-allowlisted action.
   * @param method - Exact permitted HTTP method.
   * @param path - Adapter-built path and query under the fixed provider origin.
   * @param body - Whitelisted write fields; absent for reads and deletes.
   * @param etag - Provider-issued entity tag, when conditional mutation is required.
   * @returns Bounded JSON; a bodyless success becomes an empty object.
   */
  async json(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: ProviderObject, etag?: string): Promise<ProviderObject> {
    const origin = this.connection.provider === 'google' ? 'https://www.googleapis.com' : 'https://graph.microsoft.com'
    const url = new URL(path, origin)
    if (url.origin !== origin || url.username || url.password || url.hash || !this.allowed(method, url.pathname)) {
      throw new BrokerError('endpoint_denied', 'This provider operation is not permitted by the broker.', 403)
    }
    this.assertWriteFields(method, url, body, etag)
    this.assertPermission()
    const token = await (this.token ??= this.accessToken())
    this.signal.throwIfAborted()
    this.assertPermission()
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    if (this.connection.provider === 'microsoft') headers.Prefer = 'IdType="ImmutableId", outlook.body-content-type="text", outlook.timezone="UTC"'
    if (etag !== undefined) headers['If-Match'] = etag
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let response: Response
    if (method !== 'GET') this.mutationStarted = true
    try {
      response = await this.transport(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: this.signal, redirect: 'error' })
    } catch {
      throw new BrokerError('provider_unreachable', 'The provider request did not return a reliable result. Inspect the account before repeating a change.', 502, method === 'GET' ? 'not_started' : 'unknown')
    }
    const outcome = method !== 'GET' && (response.status >= 500 || response.status === 408) ? 'unknown' : 'not_started'
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401) throw new BrokerError('reconnect_required', 'Reconnect this account in the broker console.', 401, outcome)
      if (response.status === 409 || response.status === 412) throw new BrokerError('version_conflict', 'The item changed. Read it again and review the current version before requesting another change.', 409, outcome)
      if (response.status === 429) throw new BrokerError('provider_rate_limit', 'The provider is rate limiting requests. Wait before requesting another operation.', 429, outcome)
      throw new BrokerError('provider_rejected', 'The provider rejected this operation. Check the resource and its current permissions.', 502, outcome)
    }
    try {
      const text = await boundedText(response, this.maxBytes)
      return text === '' ? {} : object(z.json().parse(JSON.parse(text)))
    } catch {
      throw new BrokerError('provider_response_invalid', 'The provider response was incomplete or exceeded the response limit.', 502, method === 'GET' ? 'not_started' : 'unknown')
    }
  }

  /**
   * Read one page, binding its signed continuation to account, resource, operation and query.
   * @param path - Initial adapter-built collection URL.
   * @param request - Current validated read request.
   * @returns Provider records and a short-lived continuation, when another page exists.
   */
  async page(path: string, request: BrokerRequest): Promise<ProviderResult> {
    const args = { ...request.arguments }
    const cursor = 'cursor' in args ? args.cursor : undefined
    if ('cursor' in args) delete args.cursor
    const binding = createHash('sha256').update(JSON.stringify({ connection: request.connectionId, resource: request.resourceId, operation: request.operation, args })).digest('hex')
    const origin = this.connection.provider === 'google' ? 'https://www.googleapis.com' : 'https://graph.microsoft.com'
    const initial = new URL(path, origin)
    let target = initial
    if (cursor !== undefined) {
      const parts = cursor.split('.')
      const payload = parts[0]
      const signature = parts[1]
      if (parts.length !== 2 || !payload || !signature) throw new BrokerError('invalid_cursor', 'Start a new query; this continuation is invalid.')
      const expected = createHmac('sha256', this.cursorKey).update(payload).digest()
      const actual = Buffer.from(signature, 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BrokerError('invalid_cursor', 'Start a new query; this continuation is invalid.')
      const parsed = z.strictObject({ binding: z.string(), expiresAt: z.number(), url: z.string() }).safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
      if (!parsed.success || parsed.data.binding !== binding || parsed.data.expiresAt <= Date.now()) throw new BrokerError('invalid_cursor', 'Start a new query; this continuation expired or belongs to another query.')
      target = new URL(parsed.data.url)
    }
    this.checkPageTarget(initial, target)
    const data = await this.json('GET', target.pathname + target.search)
    let next: URL | undefined
    if (this.connection.provider === 'google' && typeof data.nextPageToken === 'string') {
      next = new URL(initial)
      next.searchParams.set('pageToken', data.nextPageToken)
    } else if (this.connection.provider === 'microsoft' && typeof data['@odata.nextLink'] === 'string') next = new URL(data['@odata.nextLink'])
    delete data.nextPageToken
    delete data['@odata.nextLink']
    if (next === undefined) return { data }
    this.checkPageTarget(initial, next)
    const payload = Buffer.from(JSON.stringify({ binding, expiresAt: Date.now() + 600_000, url: next.href })).toString('base64url')
    return { data, nextCursor: `${payload}.${createHmac('sha256', this.cursorKey).update(payload).digest('base64url')}` }
  }

  private checkPageTarget(initial: URL, next: URL): void {
    if (next.origin !== initial.origin || next.pathname !== initial.pathname || next.username || next.password || next.hash) {
      throw new BrokerError('invalid_cursor', 'The provider continuation changed its account or resource.', 502)
    }
  }

  private allowed(method: string, path: string): boolean {
    const one = '[^/]+'
    if (this.connection.provider === 'google') {
      if (method === 'GET') return new RegExp(`^/calendar/v3/(users/me/calendarList(?:/${one})?|calendars/${one}/(?:acl|events(?:/${one})?))$`, 'u').test(path)
      if (method === 'POST') return path === '/calendar/v3/calendars' || new RegExp(`^/calendar/v3/calendars/${one}/events$`, 'u').test(path)
      return new RegExp(`^/calendar/v3/calendars/${one}/events/${one}$`, 'u').test(path)
    }
    if (method === 'GET') return new RegExp(`^/v1.0/me/(?:calendars(?:/${one}(?:/(?:calendarPermissions|calendarView|events(?:/${one})?))?)?|messages(?:/${one})?)$`, 'u').test(path)
    if (method === 'POST') return path === '/v1.0/me/calendars' || path === '/v1.0/me/messages'
      || new RegExp(`^/v1.0/me/(?:calendars/${one}/events|messages/${one}/(?:createReply|createReplyAll|createForward))$`, 'u').test(path)
    if (method === 'PATCH') return new RegExp(`^/v1.0/me/(?:messages/${one}|calendars/${one}/events/${one})$`, 'u').test(path)
    return new RegExp(`^/v1.0/me/calendars/${one}/events/${one}$`, 'u').test(path)
  }

  private assertWriteFields(method: string, url: URL, body: ProviderObject | undefined, etag: string | undefined): void {
    if (method === 'GET') return
    const google = this.connection.provider === 'google'
    const calendarEvent = url.pathname.includes('/calendars/') && url.pathname.includes('/events')
    if ((method === 'PATCH' || method === 'DELETE') && (etag === undefined || /[\r\n]/u.test(etag))) {
      throw new BrokerError('conditional_write_required', 'Updates and deletes require a provider-issued entity tag.', 403)
    }
    if (google && calendarEvent && (url.searchParams.get('sendUpdates') !== 'none' || [...url.searchParams.keys()].some(key => key !== 'sendUpdates'))) {
      throw new BrokerError('notification_denied', 'Calendar notification parameters are fixed by the no-send policy.', 403)
    }
    if (method === 'DELETE') {
      if (body !== undefined) throw new BrokerError('write_fields_denied', 'Delete requests cannot carry a provider payload.', 403)
      return
    }
    if (body === undefined) throw new BrokerError('write_fields_denied', 'A validated write payload is required.', 403)
    let fields: string[]
    if (calendarEvent) {
      fields = google ? ['summary', 'description', 'location', 'start', 'end', 'id', 'eventType', 'reminders']
        : ['subject', 'body', 'location', 'start', 'end', 'transactionId', 'isReminderOn', 'isOnlineMeeting']
      if (google) {
        const reminders = object(body.reminders)
        if (reminders.useDefault !== false || !Array.isArray(reminders.overrides) || reminders.overrides.length !== 0
          || (body.eventType !== undefined && body.eventType !== 'default')) throw new BrokerError('notification_denied', 'Automatic event actions and email reminders are forbidden.', 403)
      } else if (body.isReminderOn !== false || (body.isOnlineMeeting !== undefined && body.isOnlineMeeting !== false)) {
        throw new BrokerError('notification_denied', 'Meeting creation and reminders are forbidden.', 403)
      }
    } else if (url.pathname.endsWith('/calendars')) fields = google ? ['summary'] : ['name']
    else if (/\/create(?:Reply|ReplyAll|Forward)$/u.test(url.pathname)) {
      fields = ['comment', 'message']
      if (body.message !== undefined && Object.keys(object(body.message)).some(key => key !== 'toRecipients')) {
        throw new BrokerError('write_fields_denied', 'Only the draft comment and forward recipients are permitted.', 403)
      }
    } else fields = ['subject', 'body', 'toRecipients', 'ccRecipients', 'bccRecipients', 'categories', 'flag']
    if (Object.keys(body).some(key => !fields.includes(key))) throw new BrokerError('write_fields_denied', 'This payload contains fields outside the no-send policy.', 403)
  }
}
