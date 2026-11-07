/** Outlook reads, draft-only composition and non-receipt-generating metadata changes. */

import { BrokerError } from './errors.ts'
import { object, ProviderHttp, segment, type ProviderObject, type ProviderResult } from './provider-http.ts'
import type { BrokerRequest } from './types.ts'

type MailRequest = Extract<BrokerRequest, { operation: `mail.${string}` }>

/**
 * Execute a mailbox operation without send, read-state, deletion, rules or folder-move access.
 * @param http - Microsoft account-bound provider client.
 * @param request - Validated request admitted for this account's mailbox.
 * @returns Provider read data or the created/updated draft or metadata.
 */
export async function mailOperation(http: ProviderHttp, request: MailRequest): Promise<ProviderResult> {
  if (http.connection.provider !== 'microsoft') throw new BrokerError('provider_mismatch', 'Mail operations require a Microsoft account.')
  const root = '/v1.0/me/messages'
  if (request.operation === 'mail.list') {
    const query = new URLSearchParams({ $top: String(request.arguments.limit ?? 25), $select: 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isDraft,isRead,hasAttachments,webLink,parentFolderId,categories,flag' })
    if (request.arguments.query !== undefined) query.set('$search', JSON.stringify(request.arguments.query))
    else query.set('$orderby', 'receivedDateTime desc')
    return http.page(`${root}?${query}`, request)
  }
  if (request.operation === 'mail.createDraft') {
    const data = await http.json('POST', root, draftFields(request.arguments))
    if (data.isDraft !== true) throw new BrokerError('draft_result_unknown', 'The provider did not confirm a draft. Inspect Outlook before requesting another change.', 502, 'unknown')
    return { data }
  }
  const target = `${root}/${segment(request.arguments.messageId)}`
  const message = await http.json('GET', target)
  if (request.operation === 'mail.get') return { data: message }
  if (message['@odata.type'] !== undefined && message['@odata.type'] !== '#microsoft.graph.message') {
    throw new BrokerError('message_type_denied', 'Meeting messages and special message types are read-only.', 403)
  }
  if (request.operation === 'mail.replyDraft' || request.operation === 'mail.forwardDraft') {
    if (message.isDraft !== false) throw new BrokerError('source_not_received', 'Choose an existing received message as the draft source.')
    const action = request.operation === 'mail.forwardDraft' ? 'createForward' : request.arguments.replyAll ? 'createReplyAll' : 'createReply'
    // Graph's draft actions omit comment from the returned body; use the documented message.body.
    const body: ProviderObject = { message: draftFields(request.arguments) }
    const draft = await http.json('POST', `${target}/${action}`, body)
    if (draft.isDraft !== true) throw new BrokerError('draft_result_unknown', 'The provider did not confirm a draft. Inspect Outlook before requesting another change.', 502, 'unknown')
    return { data: draft }
  }
  const etag = message['@odata.etag']
  if (typeof etag !== 'string' || etag !== request.arguments.etag) throw new BrokerError('version_conflict', 'Read the current message and use its returned entity tag.', 409)
  if (request.operation === 'mail.updateDraft') {
    if (message.isDraft !== true) throw new BrokerError('not_a_draft', 'Only draft messages may have their content or recipients edited.', 403)
    const body = draftFields(request.arguments)
    if (Object.keys(body).length === 0) throw new BrokerError('empty_change', 'Provide at least one draft field to change.')
    const result = await http.json('PATCH', target, body, etag)
    if (result.isDraft !== true) throw new BrokerError('draft_result_unknown', 'The provider did not confirm a draft. Inspect Outlook before requesting another change.', 502, 'unknown')
    return { data: result }
  }
  const body: ProviderObject = {}
  if (request.arguments.categories !== undefined) body.categories = request.arguments.categories
  if (request.arguments.flag !== undefined) body.flag = { flagStatus: request.arguments.flag }
  if (Object.keys(body).length === 0) throw new BrokerError('empty_change', 'Provide categories or a flag to change.')
  return { data: await http.json('PATCH', target, body, etag) }
}

function draftFields(args: { subject?: string; body?: string; to?: string[]; cc?: string[]; bcc?: string[] }): ProviderObject {
  const body: ProviderObject = {}
  if (args.subject !== undefined) body.subject = args.subject
  if (args.body !== undefined) body.body = { contentType: 'Text', content: args.body }
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const addresses = args[field]
    if (addresses !== undefined) body[`${field}Recipients`] = addresses.map(address => ({ emailAddress: { address } }))
  }
  return object(body)
}
