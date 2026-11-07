import { describe, expect, it } from 'vitest'
import { ProviderHttp, segment } from '../src/provider-http.ts'
import { parseRequest } from '../src/schema.ts'
import { google, googleResponder, key, microsoft, request, transportFixture } from './support.ts'

describe('provider HTTP last-mile restrictions', () => {
  it.each(['/v1.0/me/sendMail', '/v1.0/me/messages/x/send', '/v1.0/me/messages/x/reply', '/v1.0/me/events/x/forward', '/v1.0/$batch', 'https://outside.example/collect'])('refuses POST %s even for direct adapter callers', async (path) => {
    const upstream = transportFixture(() => ({}))
    const http = new ProviderHttp(microsoft(), async () => 'secret', new AbortController().signal, 4096, key, upstream.transport)
    await expect(http.json('POST', path, {})).rejects.toThrow('not permitted')
    expect(upstream.calls).toHaveLength(0)
  })

  it('rejects recipient, automatic-reply, read-state and reminder fields at the provider boundary', async () => {
    const upstream = transportFixture(googleResponder)
    const googleHttp = new ProviderHttp(google(), async () => 'secret', new AbortController().signal, 4096, key, upstream.transport)
    await expect(googleHttp.json('POST', '/calendar/v3/calendars/calendar-a/events?sendUpdates=all', {})).rejects.toThrow('fixed')
    await expect(googleHttp.json('POST', '/calendar/v3/calendars/calendar-a/events?sendUpdates=none', { reminders: { useDefault: true } })).rejects.toThrow('forbidden')
    await expect(googleHttp.json('POST', '/calendar/v3/calendars/calendar-a/events?sendUpdates=none', { reminders: { useDefault: false, overrides: [] }, attendees: [{ email: 'someone@example.com' }] })).rejects.toThrow('outside')
    const microsoftHttp = new ProviderHttp(microsoft(), async () => 'secret', new AbortController().signal, 4096, key, upstream.transport)
    await expect(microsoftHttp.json('PATCH', '/v1.0/me/messages/a', { isRead: true }, 'etag')).rejects.toThrow('outside')
    await expect(microsoftHttp.json('PATCH', '/v1.0/me/messages/a', { body: { contentType: 'Text', content: 'body' } })).rejects.toThrow('entity tag')
    expect(upstream.calls).toHaveLength(0)
  })

  it('rejects unsafe path segments', () => {
    for (const id of ['', '.', '..', 'id\n']) expect(() => segment(id)).toThrow()
    expect(segment('address@example.com')).toBe('address%40example.com')
  })

  it('signs pagination and rejects forged, cross-resource and cross-query cursors', async () => {
    const upstream = transportFixture(() => ({ items: [], nextPageToken: 'provider-page-two' }))
    const http = new ProviderHttp(google(), async () => 'secret', new AbortController().signal, 4096, key, upstream.transport)
    const query = parseRequest(request('calendar.list', { start: '2026-11-06T00:00:00Z', end: '2026-11-07T00:00:00Z' }))
    const result = await http.page('/calendar/v3/calendars/calendar-a/events?maxResults=25', query)
    expect(result.data).not.toHaveProperty('nextPageToken')
    expect(result.nextCursor).toBeTypeOf('string')
    for (const extra of [{ cursor: 'forged.sig' }, { cursor: result.nextCursor, start: '2026-11-05T00:00:00Z' }]) {
      await expect(http.page('/calendar/v3/calendars/calendar-a/events?maxResults=25', parseRequest(request('calendar.list', { ...query.arguments, ...extra })))).rejects.toThrow('continuation')
    }
    await http.page('/calendar/v3/calendars/calendar-a/events?maxResults=25', parseRequest(request('calendar.list', { ...query.arguments, cursor: result.nextCursor })))
    expect(upstream.calls[1]!.url.searchParams.get('pageToken')).toBe('provider-page-two')
  })

  it('rejects provider next links to another resource or origin', async () => {
    const upstream = transportFixture(() => ({ value: [], '@odata.nextLink': 'https://outside.example/collect' }))
    const http = new ProviderHttp(microsoft(), async () => 'secret', new AbortController().signal, 4096, key, upstream.transport)
    await expect(http.page('/v1.0/me/messages?$top=25', parseRequest(request('mail.list', {}, 'microsoft')))).rejects.toThrow('changed its account or resource')
    expect(upstream.calls).toHaveLength(1)
  })

  it('does not follow redirects or expose provider error bodies', async () => {
    let redirect: RequestRedirect | undefined
    const http = new ProviderHttp(microsoft(), async () => 'secret', new AbortController().signal, 4096, key, async (_input, init) => {
      redirect = init?.redirect
      return new Response('private provider diagnostics', { status: 403 })
    })
    const failure = http.json('GET', '/v1.0/me/messages/a')
    await expect(failure).rejects.toMatchObject({ code: 'provider_rejected' })
    await expect(failure).rejects.not.toThrow('private')
    expect(redirect).toBe('error')
  })
})
