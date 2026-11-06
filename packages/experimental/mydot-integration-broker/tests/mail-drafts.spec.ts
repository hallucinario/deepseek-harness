/** Draft payload contracts against the real adapter and its provider HTTP boundary. */
import { describe, expect, it } from 'vitest'
import { mailOperation } from '../src/mail.ts'
import { object, ProviderHttp, type ProviderObject } from '../src/provider-http.ts'
import { parseRequest } from '../src/schema.ts'
import type { BrokerRequest } from '../src/types.ts'
import { key, microsoft, request, transportFixture } from './support.ts'

const text = '本文を確認してください。\n<literal text> & "quoted" 🚀'
const itemBody = { contentType: 'Text', content: text }
const recipient = { emailAddress: { address: 'recipient@example.com' } }
const etag = 'W/"version-1"'

type DraftRequest = Extract<BrokerRequest, { operation: 'mail.createDraft' | 'mail.updateDraft' | 'mail.replyDraft' | 'mail.forwardDraft' }>

function draftRequest(operation: DraftRequest['operation'], args: object): DraftRequest {
  const parsed = parseRequest(request(operation, args, 'microsoft'))
  if (parsed.operation === 'mail.createDraft' || parsed.operation === 'mail.updateDraft'
    || parsed.operation === 'mail.replyDraft' || parsed.operation === 'mail.forwardDraft') return parsed
  throw new Error('Expected a draft operation')
}

describe('Outlook draft body contracts', () => {
  // Graph documents that comment is omitted from the response draft body; the fixture models that boundary.
  // https://learn.microsoft.com/en-us/graph/known-issues#the-comment-parameter-for-creating-a-draft-isnt-part-of-the-message-body
  it.each([
    { action: 'createReply', operation: 'mail.replyDraft', extra: {} },
    { action: 'createReplyAll', operation: 'mail.replyDraft', extra: { replyAll: true } },
    { action: 'createForward', operation: 'mail.forwardDraft', extra: { to: ['recipient@example.com'] } },
  ] as const)('preserves the supplied text in $action without sending', async ({ action, operation, extra }) => {
    const upstream = transportFixture((call) => {
      if (call.method === 'GET') return { id: 'source', isDraft: false, body: { contentType: 'Text', content: 'Original message' } }
      const message = call.body?.message === undefined ? {} : object(call.body.message)
      return { id: 'draft-a', isDraft: true, body: message.body ?? { contentType: 'Text', content: 'Quoted source only' } }
    })
    const http = new ProviderHttp(microsoft(), async () => 'provider-token', new AbortController().signal, 4096, key, upstream.transport)
    const result = await mailOperation(http, draftRequest(operation, { messageId: 'source', body: text, ...extra }))
    expect(result.data).toMatchObject({ isDraft: true, body: itemBody })
    expect(upstream.calls.map(call => `${call.method} ${call.url.pathname}`)).toEqual([
      'GET /v1.0/me/messages/source', `POST /v1.0/me/messages/source/${action}`,
    ])
    expect(upstream.calls[1]?.body).toEqual({
      message: { body: itemBody, ...(action === 'createForward' ? { toRecipients: [recipient] } : {}) },
    })
  })

  it('creates a new unsent draft with the body on the message itself', async () => {
    const upstream = transportFixture(call => ({ id: 'draft-a', isDraft: true, ...call.body }))
    const http = new ProviderHttp(microsoft(), async () => 'provider-token', new AbortController().signal, 4096, key, upstream.transport)
    const result = await mailOperation(http, draftRequest('mail.createDraft', {
      subject: 'Review', body: text, to: ['recipient@example.com'], cc: ['copy@example.com'], bcc: ['private@example.com'],
    }))
    expect(result.data).toMatchObject({ isDraft: true, body: itemBody })
    expect(upstream.calls.map(call => `${call.method} ${call.url.pathname}`)).toEqual(['POST /v1.0/me/messages'])
    expect(upstream.calls[0]?.body).toEqual({
      subject: 'Review', body: itemBody, toRecipients: [recipient],
      ccRecipients: [{ emailAddress: { address: 'copy@example.com' } }],
      bccRecipients: [{ emailAddress: { address: 'private@example.com' } }],
    })
  })

  it('updates only the existing draft with an entity tag and the message body', async () => {
    const upstream = transportFixture(call => ({ id: 'draft-a', isDraft: true, '@odata.etag': etag, ...call.body }))
    const http = new ProviderHttp(microsoft(), async () => 'provider-token', new AbortController().signal, 4096, key, upstream.transport)
    const result = await mailOperation(http, draftRequest('mail.updateDraft', { messageId: 'draft-a', etag, body: text }))
    expect(result.data).toMatchObject({ isDraft: true, body: itemBody })
    expect(upstream.calls.map(call => `${call.method} ${call.url.pathname}`)).toEqual([
      'GET /v1.0/me/messages/draft-a', 'PATCH /v1.0/me/messages/draft-a',
    ])
    expect(upstream.calls[1]?.body).toEqual({ body: itemBody })
    expect(upstream.calls[1]?.headers.get('if-match')).toBe(etag)
  })

  it.each([
    { action: 'createReply', body: { comment: 'Legacy comment', message: { body: itemBody } } },
    { action: 'createReplyAll', body: { message: { body: itemBody, toRecipients: [recipient] } } },
    { action: 'createForward', body: { message: { body: itemBody, toRecipients: [recipient], isReadReceiptRequested: true } } },
    { action: 'createForward', body: { message: { body: itemBody, toRecipients: [recipient], isRead: true } } },
  ] satisfies Array<{ action: string; body: ProviderObject }>)('rejects unsupported $action fields before provider access', async ({ action, body }) => {
    const upstream = transportFixture(() => ({}))
    const http = new ProviderHttp(microsoft(), async () => 'provider-token', new AbortController().signal, 4096, key, upstream.transport)
    await expect(http.json('POST', `/v1.0/me/messages/source/${action}`, body)).rejects.toThrow()
    expect(upstream.calls).toHaveLength(0)
    expect(http.mutationStarted).toBe(false)
  })
})
