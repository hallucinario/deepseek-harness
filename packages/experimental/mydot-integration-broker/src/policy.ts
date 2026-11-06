/** Last-mile account, resource, OAuth and Session permission checks. */

import { BrokerError } from './errors.ts'
import type { Connection, State } from './schema.ts'
import type { BrokerRequest, Capability, ConnectionSummary, Operation, SessionGrant } from './types.ts'

const required: Record<Exclude<Operation, 'connections.list' | 'resources.list'>, Capability> = {
  'calendar.list': 'calendar.read', 'calendar.get': 'calendar.read',
  'calendar.create': 'calendar.write', 'calendar.update': 'calendar.write', 'calendar.delete': 'calendar.write',
  'mail.list': 'mail.read', 'mail.get': 'mail.read', 'mail.createDraft': 'mail.draft',
  'mail.updateDraft': 'mail.draft', 'mail.replyDraft': 'mail.draft', 'mail.forwardDraft': 'mail.draft',
  'mail.organize': 'mail.organize',
}
const googlePrefix = 'https://www.googleapis.com/auth/'
const googleAllowed = new Set(['openid', 'email', 'profile', ...['userinfo.email', 'userinfo.profile', 'calendar.calendarlist.readonly', 'calendar.events.readonly', 'calendar.events.owned', 'calendar.app.created', 'calendar.acls.readonly'].map(scope => googlePrefix + scope)])
const microsoftAllowed = new Set(['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.Read', 'Mail.ReadWrite', 'Calendars.Read', 'Calendars.ReadWrite'])

/**
 * Reject excess provider grants, including send, mailbox settings, shared and application permissions.
 * @param provider - Identity provider that issued the token.
 * @param scopes - Granted scope names returned by the OAuth library.
 * @returns Canonical granted scopes.
 */
export function checkScopes(provider: Connection['provider'], scopes: string[]): string[] {
  const normalized = scopes.map(scope => provider === 'microsoft' ? scope.replace(/^https:\/\/graph\.microsoft\.com\//u, '') : scope)
  const allowed = provider === 'google' ? googleAllowed : microsoftAllowed
  if (normalized.length === 0 || normalized.some(scope => !allowed.has(scope))) {
    throw new BrokerError('excess_oauth_scope', 'This app has unsupported permissions. Use a dedicated OAuth application with only the documented delegated scopes.', 403)
  }
  return [...new Set(normalized)]
}

/**
 * Project provider consent to broker capabilities without granting any Session access.
 * @param connection - Account and its last verified OAuth scopes.
 * @returns Capabilities available for an administrator to narrow further.
 */
export function consentCapabilities(connection: Pick<Connection, 'provider' | 'scopes'>): Capability[] {
  const scopes = checkScopes(connection.provider, connection.scopes)
  const capabilities: Capability[] = []
  if (connection.provider === 'google') {
    if (scopes.includes(googlePrefix + 'calendar.events.readonly') || scopes.includes(googlePrefix + 'calendar.events.owned')) capabilities.push('calendar.read')
    if (scopes.includes(googlePrefix + 'calendar.events.owned') || scopes.includes(googlePrefix + 'calendar.app.created')) capabilities.push('calendar.write')
  } else {
    if (scopes.includes('Calendars.Read') || scopes.includes('Calendars.ReadWrite')) capabilities.push('calendar.read')
    if (scopes.includes('Calendars.ReadWrite')) capabilities.push('calendar.write')
    if (scopes.includes('Mail.Read') || scopes.includes('Mail.ReadWrite')) capabilities.push('mail.read')
    if (scopes.includes('Mail.ReadWrite')) capabilities.push('mail.draft', 'mail.organize')
  }
  return capabilities
}

/**
 * Filter account metadata through exact, unexpired Session permissions.
 * @param state - Current administrator-owned state.
 * @param sessionId - Authenticated Host's originating Session.
 * @param now - Admission time in Unix milliseconds.
 * @returns Only connections and resources usable by this Session.
 */
export function visibleConnections(state: State, sessionId: string, now: number): ConnectionSummary[] {
  return state.connections.filter(connection => connection.enabled).flatMap((connection) => {
    const grants = state.grants.filter(grant => grant.sessionId === sessionId
      && grant.connectionId === connection.id && grant.expiresAt > now)
    const consent = consentCapabilities(connection)
    const resources = connection.resources.flatMap((resource) => {
      const capabilities = resource.capabilities.filter(capability => consent.includes(capability)
        && grants.some(grant => grant.resources.includes(resource.id) && grant.capabilities.includes(capability)))
      return capabilities.length === 0 ? [] : [{ ...resource, capabilities }]
    })
    return resources.length === 0 ? [] : [{
      connectionId: connection.id, provider: connection.provider, label: connection.label, resources,
    }]
  })
}

/**
 * Enforce every current permission immediately before provider admission, including duplicate requests.
 * @param state - Current policies, credentials and grants.
 * @param request - Strictly parsed Host request.
 * @param now - Admission time in Unix milliseconds.
 * @returns The explicitly selected account, never a fallback account.
 */
export function authorize(state: State, request: BrokerRequest, now: number): Connection {
  const connection = state.connections.find(candidate => candidate.id === request.connectionId)
  if (connection === undefined || !connection.enabled) throw new BrokerError('connection_unavailable', 'Select an enabled connection with a current Session grant.', 403)
  const visible = visibleConnections(state, request.sessionId, now).find(candidate => candidate.connectionId === connection.id)
  if (visible === undefined) throw new BrokerError('permission_denied', 'The account has no current grant for this Session. Ask its administrator to grant the required resources and operations.', 403)
  if (request.operation !== 'connections.list' && request.operation !== 'resources.list') {
    const resource = visible.resources.find(candidate => candidate.id === request.resourceId)
    if (resource === undefined || !resource.capabilities.includes(required[request.operation])) {
      throw new BrokerError('permission_denied', 'This Session is not permitted to perform that operation on the selected resource.', 403)
    }
    if (request.operation.startsWith('mail.') && (connection.provider !== 'microsoft' || request.resourceId !== 'mailbox')) {
      throw new BrokerError('resource_mismatch', 'Mail operations require this Microsoft connection’s mailbox resource.', 403)
    }
  }
  return connection
}

/**
 * Validate an administrative grant against current resources and consent.
 * @param state - Current broker state.
 * @param grant - Human-supplied exact Session permission.
 * @param maxLifetimeMs - Deployment's maximum Session grant lifetime.
 */
export function validateGrant(state: State, grant: SessionGrant, maxLifetimeMs: number): void {
  const connection = state.connections.find(candidate => candidate.id === grant.connectionId)
  if (connection === undefined || !connection.enabled) throw new BrokerError('connection_unavailable', 'Enable the connection before granting access.')
  if (grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + maxLifetimeMs) throw new BrokerError('invalid_expiry', 'Grant expiry is outside the configured lifetime.')
  if (grant.resources.length === 0 || grant.capabilities.length === 0
    || grant.resources.some(id => !connection.resources.some(resource => resource.id === id))
    || grant.capabilities.some(capability => !consentCapabilities(connection).includes(capability))) {
    throw new BrokerError('invalid_grant', 'Select connected resources and capabilities covered by provider consent.')
  }
}
