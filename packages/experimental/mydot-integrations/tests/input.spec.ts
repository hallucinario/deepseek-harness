import { describe, expect, it } from 'vitest'
import { parseRequest } from '@deepseek-ai/dsh-experimental-mydot-integration-broker/src/schema.ts'
import { resolveConfig } from '../src/config.ts'
import { argumentSchemas, requestFor, requestIdFor } from '../src/input.ts'

describe('MyDot semantic input boundary', () => {
  it('exposes only the fixed no-send operation set', () => {
    expect(Object.keys(argumentSchemas)).toEqual(['connections.list', 'resources.list', 'calendar.list', 'calendar.get', 'calendar.create', 'calendar.update', 'calendar.delete', 'mail.list', 'mail.get', 'mail.createDraft', 'mail.updateDraft', 'mail.replyDraft', 'mail.forwardDraft', 'mail.organize'])
  })

  it('binds Session and replay key from Host context and conforms to the broker parser', () => {
    const request = requestFor('mail.createDraft', { connectionId: 'account-a', resourceId: 'mailbox-a', arguments: { subject: 'Draft', body: 'Unsent', to: ['person@example.com'] } }, 'session-a', 'call-a')
    expect(parseRequest(request)).toEqual(request)
    expect(request.sessionId).toBe('session-a')
    expect(request.requestId).toBe(requestIdFor('session-a', 'call-a', 'mail.createDraft'))
    expect(request.requestId).not.toBe(requestIdFor('session-b', 'call-a', 'mail.createDraft'))
    expect(request.requestId).not.toBe(requestIdFor('session-a', 'call-b', 'mail.createDraft'))
    expect(request.requestId).not.toBe(requestIdFor('session-a', 'call-a', 'mail.forwardDraft'))
  })

  it.each(['sessionId', 'requestId', 'token', 'authorization', 'url', 'provider'])('rejects injected identity or transport field %s', (key) => {
    expect(() => requestFor('connections.list', { arguments: {}, [key]: 'injected' }, 'session-a', 'call-a')).toThrow()
  })

  it('rejects an implicit account, implicit resource and an unsafe mail operation field', () => {
    expect(() => requestFor('mail.get', { arguments: { messageId: 'm' } }, 's', 'c')).toThrow()
    expect(() => requestFor('mail.get', { connectionId: 'a', arguments: { messageId: 'm' } }, 's', 'c')).toThrow()
    for (const extra of [{ isRead: true }, { destinationId: 'Outbox' }, { send: true }, { internetMessageHeaders: [] }]) {
      expect(() => requestFor('mail.organize', { connectionId: 'a', resourceId: 'm', arguments: { messageId: 'm', etag: 'v1', ...extra } }, 's', 'c')).toThrow()
    }
  })

  it('rejects attendee, recurrence, alarm and response fields before HTTP submission', () => {
    for (const extra of [{ attendees: ['person@example.com'] }, { recurrence: {} }, { reminders: {} }, { responseStatus: 'accepted' }, { isOnlineMeeting: true }]) {
      expect(() => requestFor('calendar.create', { connectionId: 'a', resourceId: 'c', arguments: { subject: 'Private', start: '2026-11-06T09:00:00+09:00', end: '2026-11-06T10:00:00+09:00', ...extra } }, 's', 'c')).toThrow()
    }
  })

  it('requires current versions for updates and rejects CRLF versions', () => {
    for (const etag of [undefined, 'x\r\ny']) {
      expect(() => requestFor('calendar.update', { connectionId: 'a', resourceId: 'c', arguments: { eventId: 'e', subject: 'Changed', etag } }, 's', 'c')).toThrow()
    }
  })

  it.each(['http://broker.example', 'http://localhost:8000', 'https://name:secret@example.com', 'https://example.com/path', 'https://example.com/?token=x', 'https://example.com/#fragment', 'file:///tmp/broker'])('refuses unsafe broker origin %s', (brokerUrl) => {
    expect(() => resolveConfig({ brokerUrl, executorTokenFile: '/private/token' })).toThrow()
  })

  it('normalizes a safe origin and rejects invalid file/limits', () => {
    expect(resolveConfig({ brokerUrl: 'https://broker.example/', executorTokenFile: '/private/token' }).brokerUrl).toBe('https://broker.example')
    expect(() => resolveConfig({ brokerUrl: 'https://broker.example', executorTokenFile: 'relative/token' })).toThrow()
    expect(() => resolveConfig({ brokerUrl: 'https://broker.example', executorTokenFile: '/private/token', maxResultBytes: 511 })).toThrow()
    expect(() => resolveConfig({ brokerUrl: 'https://broker.example', executorTokenFile: '/private/token', requestTimeoutMs: 0 })).toThrow()
  })
})
