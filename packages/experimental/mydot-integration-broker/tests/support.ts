import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectionSchema, grantSchema } from '../src/schema.ts'
import { IntegrationBroker, type RuntimeOptions } from '../src/runtime.ts'
import { BrokerStore } from '../src/store.ts'
import type { ProviderObject } from '../src/provider-http.ts'

export const key = Buffer.alloc(32, 7)
export const options: RuntimeOptions = {
  requestTimeoutMs: 10_000, maxResponseBytes: 200_000, maxQueuedRequests: 10, microsoftConditionalWritesVerified: false,
}
export const google = () => connectionSchema.parse({
  id: 'google-a', provider: 'google', subject: 'https://accounts.google.com:owner', email: 'owner@example.com', label: 'Personal Google', enabled: true,
  scopes: ['openid', 'email', 'calendar.calendarlist.readonly', 'calendar.events.readonly', 'calendar.events.owned', 'calendar.app.created', 'calendar.acls.readonly'].map(scope => scope.startsWith('calendar.') ? `https://www.googleapis.com/auth/${scope}` : scope),
  resources: [{ id: 'calendar-a', label: 'Personal', capabilities: ['calendar.read', 'calendar.write'] }], credentials: { kind: 'google', refreshToken: 'private-google-refresh-token' },
})
export const microsoft = () => connectionSchema.parse({
  id: 'microsoft-a', provider: 'microsoft', subject: 'stable-home:tenant', email: 'owner@example.com', label: 'Work Outlook', enabled: true,
  scopes: ['openid', 'profile', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Calendars.ReadWrite'],
  resources: [{ id: 'calendar-a', label: 'Work', capabilities: ['calendar.read', 'calendar.write'] }, { id: 'mailbox', label: 'Mailbox', capabilities: ['mail.read', 'mail.draft', 'mail.organize'] }],
  credentials: { kind: 'microsoft', cache: 'private-msal-token-cache', homeAccountId: 'stable-home' },
})
export const googleEvent = (): ProviderObject => ({ id: 'event-a', etag: '"version-1"', eventType: 'default', status: 'confirmed', organizer: { self: true }, start: { dateTime: '2026-11-06T00:00:00Z' }, end: { dateTime: '2026-11-06T01:00:00Z' } })
export const microsoftEvent = (): ProviderObject => ({ id: 'event-a', '@odata.etag': 'W/"version-1"', attendees: [], isOrganizer: true, isOnlineMeeting: false, onlineMeeting: null, isCancelled: false, isAllDay: false, type: 'singleInstance', recurrence: null, organizer: { emailAddress: { address: 'owner@example.com' } }, start: { dateTime: '2026-11-06T00:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-06T01:00:00', timeZone: 'UTC' } })

export interface Call { url: URL; method: string; headers: Headers; body: ProviderObject | undefined }
export function transportFixture(respond: (call: Call) => ProviderObject | Response | Promise<ProviderObject | Response>) {
  const calls: Call[] = []
  const transport: typeof fetch = async (input, init) => {
    const call: Call = { url: new URL(input instanceof Request ? input.url : String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? JSON.parse(init.body) as ProviderObject : undefined }
    calls.push(call)
    const result = await respond(call)
    return result instanceof Response ? result : Response.json(result)
  }
  return { transport, calls }
}

export function googleResponder(call: Call): ProviderObject {
  if (call.url.pathname.includes('/calendarList/')) return { accessRole: 'owner', notificationSettings: { notifications: [] } }
  if (call.url.pathname.endsWith('/acl')) return { items: [{ role: 'owner', scope: { type: 'user', value: 'owner@example.com' } }] }
  if (call.method === 'GET' && call.url.pathname.endsWith('/events')) return { items: [googleEvent()] }
  return googleEvent()
}

export function microsoftResponder(call: Call): ProviderObject {
  if (call.url.pathname.endsWith('/calendarPermissions')) return { value: [{ role: 'none' }] }
  if (call.url.pathname === '/v1.0/me/calendars/calendar-a') return { canEdit: true, canShare: true, isSharedWithMe: false, owner: { address: 'owner@example.com' } }
  if (call.url.pathname.includes('/messages')) return { id: 'message-a', '@odata.etag': 'W/"version-1"', isDraft: true, subject: 'Draft', body: { contentType: 'Text', content: 'private message body' } }
  return microsoftEvent()
}

export async function fixture(provider: 'google' | 'microsoft', transport: typeof fetch, overrides: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mydot-broker-'))
  const store = new BrokerStore(directory, key)
  const connection = provider === 'google' ? google() : microsoft()
  store.state.connections.push(connection)
  store.state.grants.push(grantSchema.parse({ sessionId: 'session-a', connectionId: connection.id, resources: connection.resources.map(resource => resource.id), capabilities: connection.resources.flatMap(resource => resource.capabilities), expiresAt: Date.now() + 3600_000 }))
  store.save()
  const broker = new IntegrationBroker(store, async () => 'provider-access-token', { ...options, ...overrides }, key, transport)
  return { directory, store, broker, connection, async close() {
    await broker.close(); store.close(); await rm(directory, { recursive: true, force: true })
  } }
}

export function request(operation: string, args: object = {}, provider: 'google' | 'microsoft' = 'google') {
  return { version: 1, sessionId: 'session-a', connectionId: `${provider}-a`, resourceId: operation.startsWith('mail.') ? 'mailbox' : 'calendar-a', operation, requestId: '4b08791a-8e2a-4ce5-92bc-f219e8aa6218', arguments: args }
}
