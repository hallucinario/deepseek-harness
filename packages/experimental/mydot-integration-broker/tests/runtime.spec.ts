import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authorize, checkScopes, visibleConnections } from '../src/policy.ts'
import { parseRequest } from '../src/schema.ts'
import { BrokerStore } from '../src/store.ts'
import { IntegrationBroker } from '../src/runtime.ts'
import { fixture, google, googleEvent, googleResponder, key, microsoftResponder, options, request, transportFixture } from './support.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()?.() })
const event = { subject: 'Focus', start: '2026-11-06T10:00:00+09:00', end: '2026-11-06T11:00:00+09:00' }

describe('no-send request admission', () => {
  it.skipIf(process.platform === 'win32').each(['mail.send', 'mail.reply', 'mail.forward', 'calendar.forward', 'calendar.accept', 'calendar.cancel', 'http.request', '$batch'])('denies %s before provider access', async (operation) => {
    const upstream = transportFixture(googleResponder)
    const setup = await fixture('google', upstream.transport)
    cleanup.push(() => setup.close())
    expect(await setup.broker.execute(request(operation))).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(upstream.calls).toHaveLength(0)
  })

  it.each([{ attendees: [{ email: 'other@example.com' }] }, { eventType: 'outOfOffice' }, { sendUpdates: 'all' }, { reminders: { useDefault: true } }, { url: 'https://example.com' }])('rejects unsupported event fields %j', (unsafe) => {
    expect(() => parseRequest(request('calendar.create', { ...event, ...unsafe }))).toThrow('unsupported fields')
  })

  it.each(['Mail.Send', 'Mail.Send.Shared', 'SMTP.Send', 'MailboxSettings.ReadWrite', 'Mail.ReadWrite.Shared'])('rejects excess Microsoft scope %s', (scope) => {
    expect(() => checkScopes('microsoft', ['Mail.ReadWrite', scope])).toThrow('unsupported permissions')
  })

  it('rejects broad Calendar and Gmail scopes', () => {
    expect(() => checkScopes('google', ['https://www.googleapis.com/auth/calendar'])).toThrow('unsupported permissions')
    expect(() => checkScopes('google', ['https://www.googleapis.com/auth/gmail.send'])).toThrow('unsupported permissions')
  })
})

describe.skipIf(process.platform === 'win32')('account and Session permissions with private POSIX storage', () => {
  it('honors revocation during token acquisition and rejects already queued work before any provider access', async () => {
    const upstream = transportFixture(googleResponder)
    const setup = await fixture('google', upstream.transport)
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const broker = new IntegrationBroker(setup.store, async () => {
      entered.resolve(undefined)
      await released.promise
      return 'provider-access-token'
    }, options, key, upstream.transport)
    cleanup.push(async () => { released.resolve(undefined); await broker.close(); await setup.close() })
    const active = broker.execute(request('calendar.get', { eventId: 'event-a' }))
    await entered.promise
    const queued = broker.execute(request('calendar.get', { eventId: 'event-b' }))
    setup.store.state.grants = []
    setup.store.save()
    released.resolve(undefined)
    for (const result of await Promise.all([active, queued])) {
      expect(result).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    }
    expect(upstream.calls).toHaveLength(0)
  })

  it('filters connections and denies foreign accounts, resources, Sessions and expired grants', async () => {
    const upstream = transportFixture(googleResponder)
    const setup = await fixture('google', upstream.transport)
    cleanup.push(() => setup.close())
    const second = google()
    second.id = parseRequest({ ...request('calendar.get', { eventId: 'event-a' }), connectionId: 'google-b' }).connectionId!
    second.label = 'Unshared account'
    setup.store.state.connections.push(second)
    const result = await setup.broker.execute({ version: 1, sessionId: 'session-a', operation: 'connections.list', arguments: {} })
    expect(result).toMatchObject({ ok: true, data: { connections: [{ connectionId: 'google-a' }] } })
    expect(JSON.stringify(result)).not.toContain('refresh')
    expect(JSON.stringify(result)).not.toContain('Unshared account')
    for (const changed of [{ connectionId: 'google-b' }, { resourceId: 'calendar-b' }, { sessionId: 'child-session' }, { sessionId: 'scheduled-session' }]) {
      expect(await setup.broker.execute({ ...request('calendar.get', { eventId: 'event-a' }), ...changed })).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    }
    setup.store.state.grants[0]!.expiresAt = 1
    expect(visibleConnections(setup.store.state, 'session-a', Date.now())).toEqual([])
    expect(() => authorize(setup.store.state, parseRequest(request('calendar.get', { eventId: 'event-a' })), Date.now())).toThrow('no current grant')
    expect(upstream.calls).toHaveLength(0)
  })

  it('creates a personal Google appointment with fixed notification suppression and replays its receipt once', async () => {
    const upstream = transportFixture(googleResponder)
    const setup = await fixture('google', upstream.transport)
    cleanup.push(() => setup.close())
    const first = await setup.broker.execute(request('calendar.create', event))
    expect(first).toMatchObject({ ok: true, connectionId: 'google-a', resourceId: 'calendar-a', accountLabel: 'Personal Google' })
    expect(await setup.broker.execute(request('calendar.create', event))).toEqual(first)
    const writes = upstream.calls.filter(call => call.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.url.searchParams.get('sendUpdates')).toBe('none')
    expect(writes[0]!.body).toMatchObject({ eventType: 'default', reminders: { useDefault: false, overrides: [] }, start: { dateTime: '2026-11-06T01:00:00.000Z' } })
    expect(writes[0]!.body?.attendees).toBeUndefined()
    expect(await setup.broker.execute(request('calendar.create', { ...event, subject: 'Different' }))).toMatchObject({ ok: false, error: { code: 'request_id_reused' } })
    setup.store.state.grants = []
    expect(await setup.broker.execute(request('calendar.create', event))).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  })

  it('does not repeat a timed-out creation', async () => {
    const upstream = transportFixture((call) => { if (call.method === 'POST') throw new Error('ambiguous network failure with secret'); return googleResponder(call) })
    const setup = await fixture('google', upstream.transport)
    cleanup.push(() => setup.close())
    const first = await setup.broker.execute(request('calendar.create', event))
    expect(first).toMatchObject({ ok: false, error: { code: 'provider_unreachable', outcome: 'unknown' } })
    expect(JSON.stringify(first)).not.toContain('secret')
    expect(await setup.broker.execute(request('calendar.create', event))).toEqual(first)
    expect(upstream.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('fresh-reads events, refuses an attendee race and sends If-Match on safe changes', async () => {
    let invited = true
    const upstream = transportFixture(call => call.url.pathname.endsWith('/events/event-a') && call.method === 'GET'
      ? { ...googleEvent(), ...(invited ? { attendees: [{ email: 'other@example.com' }] } : {}) } : googleResponder(call))
    const setup = await fixture('google', upstream.transport)
    cleanup.push(() => setup.close())
    const args = { eventId: 'event-a', etag: '"version-1"', subject: 'Changed' }
    expect(await setup.broker.execute(request('calendar.update', args))).toMatchObject({ ok: false, error: { code: 'event_may_notify' } })
    expect(upstream.calls.filter(call => call.method === 'PATCH')).toHaveLength(0)
    invited = false
    expect(await setup.broker.execute({ ...request('calendar.update', args), requestId: '4b08791a-8e2a-4ce5-92bc-f219e8aa6219' })).toMatchObject({ ok: true })
    expect(upstream.calls.find(call => call.method === 'PATCH')?.headers.get('if-match')).toBe('"version-1"')
  })

  it('treats a stale provider entity tag as a conflict without an unconditional fallback', async () => {
    const upstream = transportFixture(call => call.method === 'PATCH' ? new Response('', { status: 412 }) : googleResponder(call))
    const setup = await fixture('google', upstream.transport)
    cleanup.push(() => setup.close())
    expect(await setup.broker.execute(request('calendar.update', { eventId: 'event-a', etag: '"version-1"', subject: 'Changed' }))).toMatchObject({ ok: false, error: { code: 'version_conflict' } })
    expect(upstream.calls.filter(call => call.method === 'PATCH')).toHaveLength(1)
  })

  it('refuses calendars with sharing or email notifications', async () => {
    for (const shared of [true, false]) {
      const upstream = transportFixture((call) => {
        if (shared && call.url.pathname.endsWith('/acl')) return { items: [{ role: 'reader', scope: { type: 'user', value: 'someone@example.com' } }] }
        if (!shared && call.url.pathname.includes('/calendarList/')) return { accessRole: 'owner', notificationSettings: { notifications: [{ method: 'email' }] } }
        return googleResponder(call)
      })
      const setup = await fixture('google', upstream.transport)
      cleanup.push(() => setup.close())
      expect(await setup.broker.execute(request('calendar.create', event))).toMatchObject({ ok: false, error: { code: shared ? 'calendar_shared' : 'email_notification_enabled' } })
      expect(upstream.calls.some(call => call.method !== 'GET')).toBe(false)
    }
  })

  it('keeps Outlook conditional writes disabled until the deployment qualifies If-Match', async () => {
    const upstream = transportFixture(microsoftResponder)
    const setup = await fixture('microsoft', upstream.transport)
    cleanup.push(() => setup.close())
    expect(await setup.broker.execute(request('calendar.update', { eventId: 'event-a', etag: 'W/"version-1"', subject: 'Changed' }, 'microsoft'))).toMatchObject({ ok: false, error: { code: 'conditional_writes_unverified' } })
    expect(upstream.calls.some(call => call.method !== 'GET')).toBe(false)
  })

  it('creates Outlook drafts without a send or read-state request', async () => {
    const upstream = transportFixture(microsoftResponder)
    const setup = await fixture('microsoft', upstream.transport)
    cleanup.push(() => setup.close())
    expect(await setup.broker.execute(request('mail.createDraft', { subject: 'Review', body: 'Please review', to: ['recipient@example.com'] }, 'microsoft'))).toMatchObject({ ok: true, data: { isDraft: true } })
    expect(upstream.calls.map(call => `${call.method} ${call.url.pathname}`)).toEqual(['POST /v1.0/me/messages'])
    expect(upstream.calls[0]!.headers.get('prefer')).toContain('IdType="ImmutableId"')
    expect(upstream.calls[0]!.body).not.toHaveProperty('isRead')
  })

  it('creates reply and forward drafts from the source account and rejects editing received bodies', async () => {
    const upstream = transportFixture(call => call.method === 'GET' ? { ...microsoftResponder(call), isDraft: false } : microsoftResponder(call))
    const setup = await fixture('microsoft', upstream.transport)
    cleanup.push(() => setup.close())
    expect(await setup.broker.execute(request('mail.replyDraft', { messageId: 'source', body: 'Reply', replyAll: true }, 'microsoft'))).toMatchObject({ ok: true })
    expect(upstream.calls[1]!.url.pathname).toBe('/v1.0/me/messages/source/createReplyAll')
    expect(await setup.broker.execute({ ...request('mail.forwardDraft', { messageId: 'source', body: 'Forward', to: ['recipient@example.com'] }, 'microsoft'), requestId: '4b08791a-8e2a-4ce5-92bc-f219e8aa6219' })).toMatchObject({ ok: true })
    expect(upstream.calls[3]!.url.pathname).toBe('/v1.0/me/messages/source/createForward')
    expect(await setup.broker.execute({ ...request('mail.updateDraft', { messageId: 'source', etag: 'W/"version-1"', body: 'Edited' }, 'microsoft'), requestId: '4b08791a-8e2a-4ce5-92bc-f219e8aa6220' })).toMatchObject({ ok: false, error: { code: 'not_a_draft' } })
    expect(upstream.calls.filter(call => call.method === 'PATCH')).toHaveLength(0)
  })

  it('encrypts account credentials and refuses concurrent processes sharing a database', async () => {
    const setup = await fixture('google', transportFixture(googleResponder).transport)
    cleanup.push(() => setup.close())
    expect((await readFile(join(setup.directory, 'broker.sqlite'))).includes(Buffer.from('private-google-refresh-token'))).toBe(false)
    expect(() => new BrokerStore(setup.directory, key)).toThrow()
  })
})
