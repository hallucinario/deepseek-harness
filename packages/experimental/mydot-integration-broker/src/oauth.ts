/** Authorization-code flows with PKCE, one-use browser-bound state and isolated token caches. */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  ConfidentialClientApplication,
  type INetworkModule,
  type NetworkRequestOptions,
  type NetworkResponse,
} from '@azure/msal-node'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'
import { z } from 'zod'
import { BrokerError } from './errors.ts'
import { checkScopes } from './policy.ts'
import { boundedText } from './provider-http.ts'
import type { Connection } from './schema.ts'
import { BrokerStore, readSecret } from './store.ts'
import type { ConnectionId, Provider } from './types.ts'

const client = { clientId: z.string().min(1), clientSecret: z.string().min(1) }
const configSchema = z.strictObject({
  google: z.strictObject(client).optional(),
  microsoft: z.strictObject({ ...client, tenant: z.string().regex(/^(?:common|organizations|consumers|[0-9a-fA-F-]{36})$/u) }).optional(),
})
interface PendingAuthorization {
  provider: Provider
  browserSession: string
  verifier: string
  nonce: string
  scopes: string[]
  expiresAt: number
  connectionId: ConnectionId | undefined
}
const googlePrefix = 'https://www.googleapis.com/auth/'

/** Limits shared by each complete OAuth SDK operation and its response bodies. */
export interface OAuthNetworkOptions {
  requestTimeoutMs: number
  maxResponseBytes: number
}

class MicrosoftOAuthNetwork implements INetworkModule {
  private readonly signal: AbortSignal

  constructor(private readonly options: OAuthNetworkOptions) {
    this.signal = AbortSignal.timeout(options.requestTimeoutMs)
  }

  sendGetRequestAsync<T>(url: string, options?: NetworkRequestOptions, timeout?: number): Promise<NetworkResponse<T>> {
    const signal = timeout === undefined ? this.signal
      : AbortSignal.any([this.signal, AbortSignal.timeout(Math.min(timeout, this.options.requestTimeoutMs))])
    return this.request<T>('GET', url, options, signal)
  }

  sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
    return this.request<T>('POST', url, options, this.signal)
  }

  private async request<T>(
    method: 'GET' | 'POST', target: string, options: NetworkRequestOptions | undefined, signal: AbortSignal,
  ): Promise<NetworkResponse<T>> {
    const url = new URL(target)
    if (url.origin !== 'https://login.microsoftonline.com' || url.username || url.password || url.hash) {
      throw new BrokerError('oauth_endpoint_denied', 'The Microsoft identity endpoint is not permitted.', 403)
    }
    signal.throwIfAborted()
    const response = await fetch(url, {
      method, ...(options?.headers === undefined ? {} : { headers: options.headers }),
      ...(options?.body === undefined ? {} : { body: options.body }), signal, redirect: 'error',
    })
    const text = await boundedText(response, this.options.maxResponseBytes)
    signal.throwIfAborted()
    const body: unknown = JSON.parse(text)
    // MSAL owns validation of the endpoint-specific JSON selected by T.
    return { headers: Object.fromEntries(response.headers), body: body as T, status: response.status }
  }
}

/** Provider consent and credential refresh, owned exclusively by the broker process. */
export class BrokerOAuth {
  private readonly configuration: z.infer<typeof configSchema>
  private readonly pending = new Map<string, PendingAuthorization>()

  constructor(
    private readonly store: BrokerStore,
    private readonly origin: string,
    configurationFile: string,
    private readonly options: OAuthNetworkOptions,
  ) {
    this.configuration = configSchema.parse(JSON.parse(readSecret(configurationFile)))
    if (this.configuration.google === undefined && this.configuration.microsoft === undefined) throw new Error('Configure at least one OAuth provider')
  }

  /**
   * Begin human-authorized account consent; reconnects must preserve the existing stable identity.
   * @param provider - Explicitly selected identity provider.
   * @param write - Whether the human requested calendar and draft write consent.
   * @param browserSession - Authenticated administrative browser session hash.
   * @param connectionId - Existing connection to reconnect, or undefined for a new account.
   * @returns Provider authorization URL with fixed callback, PKCE, state and nonce.
   */
  async begin(provider: Provider, write: boolean, browserSession: string, connectionId: ConnectionId | undefined): Promise<string> {
    for (const [key, value] of this.pending) if (value.expiresAt <= Date.now()) this.pending.delete(key)
    if (this.pending.size >= 32) throw new BrokerError('authorization_busy', 'Finish or wait for an earlier account connection before starting another.', 429)
    if (connectionId !== undefined && !this.store.state.connections.some(
      connection => connection.id === connectionId && connection.provider === provider,
    )) {
      throw new BrokerError('connection_unavailable', 'Reconnect an existing account of the selected provider.')
    }
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const scopes = provider === 'google'
      ? ['openid', 'email', ...[
        'calendar.calendarlist.readonly', 'calendar.events.readonly', 'calendar.acls.readonly',
        ...(write ? ['calendar.events.owned', 'calendar.app.created'] : []),
      ].map(scope => googlePrefix + scope)]
      : [
        'openid', 'profile', 'email', 'offline_access', 'User.Read',
        write ? 'Mail.ReadWrite' : 'Mail.Read', write ? 'Calendars.ReadWrite' : 'Calendars.Read',
      ]
    let url: string
    if (provider === 'google') {
      const authorization = new URL(this.google().generateAuthUrl({
        scope: scopes, state, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: false,
        code_challenge: challenge, code_challenge_method: CodeChallengeMethod.S256,
      }))
      authorization.searchParams.set('nonce', nonce)
      url = authorization.href
    } else {
      url = await this.microsoft().getAuthCodeUrl({
        scopes, state, nonce, redirectUri: this.callback(provider),
        codeChallenge: challenge, codeChallengeMethod: 'S256', prompt: 'select_account',
      })
    }
    this.pending.set(state, { provider, browserSession, verifier, nonce, scopes, expiresAt: Date.now() + 600_000, connectionId })
    return url
  }

  /**
   * Consume an authorization callback and persist only verified, correctly scoped credentials.
   * @param provider - Callback route provider, which must match the pending flow.
   * @param state - One-use OAuth state from the provider redirect.
   * @param code - Authorization code exchanged only at the selected provider.
   * @param browserSession - Current authenticated administrative browser session hash.
   * @returns Display-safe stable connection identifier.
   */
  async complete(provider: Provider, state: string, code: string, browserSession: string): Promise<ConnectionId> {
    const pending = this.pending.get(state)
    this.pending.delete(state)
    if (pending === undefined || pending.provider !== provider
      || pending.expiresAt <= Date.now() || pending.browserSession !== browserSession) {
      throw new BrokerError('invalid_oauth_state', 'This account connection expired or belongs to another browser. Start again.', 403)
    }
    let credentials: Connection['credentials']
    let subject: string
    let email: string
    let scopes: string[]
    try {
      if (provider === 'google') {
        const oauth = this.google()
        const { tokens } = await oauth.getToken({ code, codeVerifier: pending.verifier, redirect_uri: this.callback(provider) })
        if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) throw new Error('incomplete Google authorization')
        const audience = this.configuration.google?.clientId
        if (audience === undefined) throw new Error('Google client unavailable')
        const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience })
        const claims = ticket.getPayload()
        if (claims === undefined || !('nonce' in claims) || claims.nonce !== pending.nonce
          || claims.email_verified !== true || !claims.email) throw new Error('invalid Google identity')
        const info = await oauth.getTokenInfo(tokens.access_token)
        if (info.aud !== this.configuration.google?.clientId || (info.sub !== undefined && info.sub !== claims.sub)) {
          throw new Error('Google access token identity mismatch')
        }
        subject = `https://accounts.google.com:${claims.sub}`
        email = claims.email
        scopes = checkScopes(provider, info.scopes)
        credentials = { kind: 'google', refreshToken: tokens.refresh_token }
      } else {
        const oauth = this.microsoft()
        const result = await oauth.acquireTokenByCode({
          code, scopes: pending.scopes, codeVerifier: pending.verifier, redirectUri: this.callback(provider),
        })
        const claims = result.idTokenClaims
        if (!result.account || !('nonce' in claims) || claims.nonce !== pending.nonce
          || result.account.tenantId !== result.tenantId) throw new Error('invalid Microsoft identity')
        subject = `${result.account.homeAccountId}:${result.tenantId}`
        email = result.account.username
        scopes = checkScopes(provider, result.scopes)
        credentials = { kind: 'microsoft', cache: oauth.getTokenCache().serialize(), homeAccountId: result.account.homeAccountId }
      }
    } catch (error) {
      if (error instanceof BrokerError) throw error
      throw new BrokerError('oauth_failed',
        'Provider consent could not be verified. Check the registered callback, app permissions and selected account, then reconnect.', 403)
    }
    const existing = pending.connectionId === undefined
      ? this.store.state.connections.find(connection => connection.provider === provider && connection.subject === subject)
      : this.store.state.connections.find(connection => connection.id === pending.connectionId)
    if (pending.connectionId !== undefined && existing === undefined) {
      throw new BrokerError('connection_unavailable',
        'This connection was disconnected while authorization was pending. Start a new connection.', 403)
    }
    if (existing !== undefined && (existing.provider !== provider || existing.subject !== subject)) {
      throw new BrokerError('account_mismatch', 'The selected account differs from the account being reconnected. Start a new connection instead.', 403)
    }
    const connection: Connection = {
      id: existing?.id ?? brandString<ConnectionId>(randomUUID()), provider, subject, label: email, email, scopes,
      enabled: existing?.enabled ?? true, resources: existing?.resources ?? [], credentials,
    }
    if (existing === undefined) {
      if (this.store.state.connections.length >= 64) throw new BrokerError('account_limit', 'Disconnect an unused account before adding another.')
      this.store.state.connections.push(connection)
    } else Object.assign(existing, connection)
    this.store.save()
    return connection.id
  }

  /**
   * Acquire one short-lived access token without exporting it beyond the provider adapter.
   * @param connection - Explicit broker-owned account record.
   * @returns An access token for this account after verifying effective delegated scopes.
   */
  async accessToken(connection: Connection): Promise<string> {
    try {
      if (connection.provider === 'google' && connection.credentials.kind === 'google') {
        const oauth = this.google()
        oauth.setCredentials({ refresh_token: connection.credentials.refreshToken })
        const { token } = await oauth.getAccessToken()
        if (!token) throw new Error('missing Google access token')
        const info = await oauth.getTokenInfo(token)
        if (info.aud !== this.configuration.google?.clientId
          || (info.sub !== undefined && connection.subject !== `https://accounts.google.com:${info.sub}`)) {
          throw new Error('Google account changed')
        }
        connection.scopes = checkScopes('google', info.scopes)
        if (oauth.credentials.refresh_token) connection.credentials.refreshToken = oauth.credentials.refresh_token
        this.store.save()
        return token
      }
      if (connection.provider === 'microsoft' && connection.credentials.kind === 'microsoft') {
        const oauth = this.microsoft()
        oauth.getTokenCache().deserialize(connection.credentials.cache)
        const account = await oauth.getTokenCache().getAccountByHomeId(connection.credentials.homeAccountId)
        if (!account || `${account.homeAccountId}:${account.tenantId}` !== connection.subject) throw new Error('Microsoft account changed')
        const result = await oauth.acquireTokenSilent({
          account, scopes: connection.scopes.filter(scope => !['openid', 'profile', 'email', 'offline_access'].includes(scope)),
        })
        if (!result.account || `${result.account.homeAccountId}:${result.tenantId}` !== connection.subject) throw new Error('Microsoft result identity changed')
        connection.scopes = checkScopes('microsoft', result.scopes)
        connection.credentials.cache = oauth.getTokenCache().serialize()
        this.store.save()
        return result.accessToken
      }
      throw new Error('credential provider mismatch')
    } catch (error) {
      if (error instanceof BrokerError) throw error
      throw new BrokerError('reconnect_required',
        'This account needs provider reauthorization. Reconnect it in the broker console; another account will not be substituted.', 401)
    }
  }

  private callback(provider: Provider): string { return `${this.origin}/oauth/callback/${provider}` }

  private google(): OAuth2Client {
    const config = this.configuration.google
    if (config === undefined) throw new BrokerError('provider_unconfigured', 'Google OAuth is not configured.')
    const signal = AbortSignal.timeout(this.options.requestTimeoutMs)
    const oauth = new OAuth2Client({
      clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: this.callback('google'),
      transporterOptions: {
        timeout: this.options.requestTimeoutMs, maxContentLength: this.options.maxResponseBytes,
        retry: false, redirect: 'error', signal,
      },
    })
    // SDK token methods supply retry:true per request, overriding transporter defaults.
    oauth.transporter.interceptors.request.add({
      resolved: (request) => {
        request.retry = false
        request.signal = signal
        signal.throwIfAborted()
        return Promise.resolve(request)
      },
    })
    return oauth
  }

  private microsoft(): ConfidentialClientApplication {
    const config = this.configuration.microsoft
    if (config === undefined) throw new BrokerError('provider_unconfigured', 'Microsoft OAuth is not configured.')
    return new ConfidentialClientApplication({
      auth: {
        clientId: config.clientId, clientSecret: config.clientSecret,
        authority: `https://login.microsoftonline.com/${config.tenant}`,
      },
      system: { networkClient: new MicrosoftOAuthNetwork(this.options) },
    })
  }
}
