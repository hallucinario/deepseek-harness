/** Personal-appointment adapters; meeting, sharing and automatic-decline operations are excluded. */

import { createHash } from 'node:crypto'
import { BrokerError } from './errors.ts'
import { object, ProviderHttp, segment, type ProviderObject, type ProviderResult } from './provider-http.ts'
import type { BrokerRequest, JsonValue } from './types.ts'

type CalendarRequest = Extract<BrokerRequest, { operation: `calendar.${string}` }>

/**
 * Execute a calendar read or a notification-free personal appointment mutation.
 * @param http - Account-bound provider client.
 * @param request - Strictly parsed request with current account/resource permission.
 * @param conditionalMicrosoftWrites - Operator evidence that Graph rejects stale entity tags.
 * @returns Provider data and continuation, never a substituted account.
 */
export async function calendarOperation(
  http: ProviderHttp, request: CalendarRequest, conditionalMicrosoftWrites: boolean,
): Promise<ProviderResult> {
  if (request.resourceId === undefined) throw new BrokerError('resource_required', 'Select a calendar.')
  const google = http.connection.provider === 'google'
  const root = google ? `/calendar/v3/calendars/${segment(request.resourceId)}` : `/v1.0/me/calendars/${segment(request.resourceId)}`
  const events = `${root}/events`
  if (request.operation === 'calendar.list') {
    const query = new URLSearchParams(google
      ? { timeMin: request.arguments.start, timeMax: request.arguments.end, singleEvents: 'true', orderBy: 'startTime', maxResults: String(request.arguments.limit ?? 50) }
      : { startDateTime: request.arguments.start, endDateTime: request.arguments.end, $top: String(request.arguments.limit ?? 50), $orderby: 'start/dateTime' })
    return http.page(`${google ? events : root + '/calendarView'}?${query}`, request)
  }
  if (request.operation === 'calendar.get') return { data: await http.json('GET', `${events}/${segment(request.arguments.eventId)}`) }
  await assertPrivateCalendar(http, request.resourceId)
  if (request.operation === 'calendar.create') {
    const body = eventFields(google, request.arguments)
    if (google) {
      body.id = `md${createHash('sha256').update(`${http.connection.id}:${request.sessionId}:${request.requestId}`).digest('hex')}`
      body.eventType = 'default'
    } else { body.transactionId = request.requestId ?? ''; body.isOnlineMeeting = false }
    const result = await http.json('POST', google ? `${events}?sendUpdates=none` : events, body)
    return { data: result }
  }
  if (!google && !conditionalMicrosoftWrites) {
    throw new BrokerError('conditional_writes_unverified', 'Outlook updates and deletes are disabled until the operator verifies stale If-Match rejection for this deployment. Creating personal appointments remains available.', 403)
  }
  const target = `${events}/${segment(request.arguments.eventId)}`
  const current = await http.json('GET', target)
  assertPersonalEvent(current, google, http.connection.email)
  const currentTag = google ? current.etag : current['@odata.etag']
  if (typeof currentTag !== 'string' || currentTag !== request.arguments.etag) {
    throw new BrokerError('version_conflict', 'Read the current event and use its returned entity tag before changing it.', 409)
  }
  if (request.operation === 'calendar.delete') {
    await http.json('DELETE', google ? `${target}?sendUpdates=none` : target, undefined, currentTag)
    return { data: { deleted: true, eventId: request.arguments.eventId } }
  }
  const args = request.arguments
  if (args.subject === undefined && args.body === undefined && args.location === undefined
    && args.start === undefined && args.end === undefined) {
    throw new BrokerError('empty_change', 'Provide at least one appointment field to change.')
  }
  const start = args.start ?? eventTime(current.start, google)
  const end = args.end ?? eventTime(current.end, google)
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) throw new BrokerError('invalid_time_range', 'End must follow start.')
  const body = eventFields(google, args)
  return { data: await http.json('PATCH', google ? `${target}?sendUpdates=none` : target, body, currentTag) }
}

/**
 * Verify ownership and current sharing metadata before each calendar write.
 * @param http - Account-bound provider client.
 * @param calendarId - Exact explicitly permitted calendar.
 */
export async function assertPrivateCalendar(http: ProviderHttp, calendarId: string): Promise<void> {
  const google = http.connection.provider === 'google'
  const root = google ? `/calendar/v3/calendars/${segment(calendarId)}` : `/v1.0/me/calendars/${segment(calendarId)}`
  const metadata = await http.json('GET', google ? `/calendar/v3/users/me/calendarList/${segment(calendarId)}` : root)
  const permissions = await http.json('GET', `${root}/${google ? 'acl' : 'calendarPermissions'}`)
  if (permissions.nextPageToken || permissions['@odata.nextLink']) throw new BrokerError('calendar_sharing_unknown', 'This calendar has unverified sharing entries and is read-only.', 403)
  const entries = google ? permissions.items : permissions.value
  if (!Array.isArray(entries)) throw new BrokerError('calendar_sharing_unknown', 'The provider did not expose complete sharing metadata. This calendar is read-only.', 403)
  const email = http.connection.email.toLowerCase()
  if (google) {
    if (metadata.accessRole !== 'owner') throw new BrokerError('calendar_not_owned', 'Only calendars owned by this account can be changed.', 403)
    if (metadata.notificationSettings !== undefined) {
      const notifications = object(metadata.notificationSettings).notifications
      if (notifications !== undefined && (!Array.isArray(notifications) || notifications.some(value => object(value).method === 'email'))) {
        throw new BrokerError('email_notification_enabled', 'Disable calendar email notifications in Google Calendar before allowing writes.', 403)
      }
    }
    if (entries.length === 0 || entries.some((value) => {
      const permission = object(value)
      const scope = object(permission.scope)
      return permission.role !== 'owner' || scope.type !== 'user' || typeof scope.value !== 'string' || scope.value.toLowerCase() !== email
    })) throw new BrokerError('calendar_shared', 'Shared calendars remain read-only. Select a private calendar owned by this account.', 403)
  } else {
    const owner = object(metadata.owner)
    if (metadata.canEdit !== true || metadata.canShare !== true || metadata.isSharedWithMe !== false || typeof owner.address !== 'string' || owner.address.toLowerCase() !== email) {
      throw new BrokerError('calendar_not_owned', 'Only calendars verifiably owned by this account can be changed.', 403)
    }
    if (entries.some((value) => {
      const permission = object(value)
      if (permission.role === 'none') return false
      const address = permission.emailAddress === undefined ? undefined : object(permission.emailAddress).address
      if (typeof address === 'string' && address.toLowerCase() === email) return false
      return !(permission.isRemovable === false && address === undefined && permission.role === 'freeBusyRead')
    })) throw new BrokerError('calendar_shared', 'Calendars shared with named people or delegates remain read-only.', 403)
  }
}

/**
 * Reject meetings, response-triggering events, recurrence and incomplete safety metadata.
 * @param event - Fresh complete provider resource.
 * @param google - Whether the Google resource vocabulary is in use.
 * @param email - Verified display address of the connected owner.
 */
export function assertPersonalEvent(event: ProviderObject, google: boolean, email: string): void {
  const attendees = event.attendees
  const hasAttendees = attendees !== undefined && (!Array.isArray(attendees) || attendees.length !== 0)
  const organizer = object(event.organizer)
  const organizerAddress = google ? undefined : object(organizer.emailAddress).address
  const safe = google
    ? !hasAttendees && event.attendeesOmitted !== true && organizer.self === true
      && event.eventType === 'default' && event.status === 'confirmed' && event.recurringEventId === undefined
      && event.recurrence === undefined && event.conferenceData === undefined
      && event.focusTimeProperties === undefined && event.outOfOfficeProperties === undefined
      && object(event.start).date === undefined && object(event.end).date === undefined
    : Array.isArray(attendees) && attendees.length === 0 && event.isOrganizer === true && event.isOnlineMeeting === false
      && event.onlineMeeting === null && event.isCancelled === false && event.type === 'singleInstance'
      && event.recurrence === null && event.isAllDay === false
      && typeof organizerAddress === 'string' && organizerAddress.toLowerCase() === email.toLowerCase()
  if (!safe) throw new BrokerError('event_may_notify', 'This event is a meeting, recurrence, all-day event or has incomplete safety metadata. It is read-only under the no-send policy.', 403)
}

function eventTime(value: JsonValue | undefined, google: boolean): string {
  const time = object(value)
  if (typeof time.dateTime !== 'string') throw new BrokerError('event_time_unknown', 'The existing event time cannot be safely changed.')
  if (google) return time.dateTime
  if (time.timeZone !== 'UTC') throw new BrokerError('event_time_unknown', 'The provider must return the event time in UTC.')
  return /(?:Z|[+-]\d{2}:\d{2})$/u.test(time.dateTime) ? time.dateTime : time.dateTime + 'Z'
}

function eventFields(
  google: boolean, args: { subject?: string; body?: string; location?: string; start?: string; end?: string },
): ProviderObject {
  const result: ProviderObject = google ? { reminders: { useDefault: false, overrides: [] } } : { isReminderOn: false }
  if (args.subject !== undefined) result[google ? 'summary' : 'subject'] = args.subject
  if (args.body !== undefined) result[google ? 'description' : 'body'] = google ? args.body : { contentType: 'Text', content: args.body }
  if (args.location !== undefined) result.location = google ? args.location : { displayName: args.location }
  for (const key of ['start', 'end'] as const) {
    const value = args[key]
    if (value !== undefined) result[key] = google ? { dateTime: new Date(value).toISOString() } : { dateTime: new Date(value).toISOString().slice(0, -1), timeZone: 'UTC' }
  }
  return result
}
