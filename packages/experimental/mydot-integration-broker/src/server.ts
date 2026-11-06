/** Separate human administration and agent execution credentials on an isolated loopback listener. */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { escapeHtml, homePage, loginPage, page, resourcesPage } from './admin-html.ts'
import { BrokerError, failure } from './errors.ts'
import { closeListener, listenExecutor } from './executor-listener.ts'
import type { BrokerOAuth } from './oauth.ts'
import { consentCapabilities, validateGrant } from './policy.ts'
import { object } from './provider-http.ts'
import { IntegrationBroker } from './runtime.ts'
import { capabilitySchema, grantSchema, resourcePolicySchema, type Connection } from './schema.ts'
import type { ResourcePolicy } from './types.ts'

/** HTTP-only deployment settings; all externally advertised callbacks use publicOrigin. */
export interface ServerOptions {
  /** Exact loopback address; remote access requires an authenticated deployment boundary. */
  host: '127.0.0.1'
  /** TCP listener port; zero permits an OS-assigned port for tests. */
  port: number
  /** Exact external HTTPS origin used by administrative forms and OAuth callbacks. */
  publicOrigin: string
  /** Maximum bytes in an incoming execution request or administrative form. */
  maxBodyBytes: number
  /** Maximum request duration in milliseconds. */
  requestTimeoutMs: number
  /** Maximum lifetime of a human-issued Session grant in milliseconds. */
  maxGrantLifetimeMs: number
  /** Protected Unix execution socket; omission starts an administrative-only broker. */
  executorSocketPath?: string
  /** Private administrative Unix socket; when configured, no TCP listener is opened. */
  adminSocketPath?: string
}
interface AdminSession { csrf: string; expiresAt: number }

/** Loopback broker listener with script-free, cookie-authenticated human administration. */
export class BrokerServer {
  private readonly sessions = new Map<string, AdminSession>()
  private readonly active = new Set<Promise<void>>()
  private readonly server = createServer((request, response) => { this.accept(request, response, false) })
  private readonly executor = createServer((request, response) => { this.accept(request, response, true) })

  private accept(request: IncomingMessage, response: ServerResponse, execution: boolean): void {
    const action = this.handle(request, response, execution).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return }
      response.statusCode = error instanceof BrokerError ? error.status : 500
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify(failure(error)))
    }).finally(() => { this.active.delete(action) })
    this.active.add(action)
  }

  constructor(
    private readonly broker: IntegrationBroker,
    private readonly oauth: Pick<BrokerOAuth, 'begin' | 'complete'>,
    private readonly options: ServerOptions,
    private readonly executorToken: string,
    private readonly adminToken: string,
  ) {
    if (equal(executorToken, adminToken)) throw new Error('Administrative and execution credentials must differ')
    for (const listener of [this.server, this.executor]) {
      listener.requestTimeout = options.requestTimeoutMs
      listener.headersTimeout = options.requestTimeoutMs
      listener.maxHeadersCount = 100
    }
  }

  /** Bind the administrative transport and the optional protected execution socket. */
  async listen(): Promise<void> {
    if (this.options.adminSocketPath !== undefined) {
      await listenExecutor(this.server, this.options.adminSocketPath, 0o600)
    } else {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(this.options.port, this.options.host, () => { this.server.off('error', reject); resolve() })
      })
    }
    try {
      if (this.options.executorSocketPath !== undefined) await listenExecutor(this.executor, this.options.executorSocketPath)
    } catch (error) {
      await closeListener(this.server)
      throw error
    }
  }

  /**
   * Return the actual listener port, including an OS-assigned test port.
   * @returns Bound TCP port.
   */
  port(): number {
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Broker listener is not bound')
    return address.port
  }

  /** Stop ingress and drain admitted requests before releasing the encrypted store. */
  async close(): Promise<void> {
    const closed = Promise.all([closeListener(this.server), closeListener(this.executor)])
    await this.broker.close()
    await Promise.allSettled([...this.active])
    await closed
  }

  private async handle(request: IncomingMessage, response: ServerResponse, execution: boolean): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    const url = new URL(request.url ?? '/', this.options.publicOrigin)
    if (execution && (request.method !== 'POST' || url.pathname !== '/v1/execute')) {
      throw new BrokerError('route_denied', 'The execution transport cannot access administrative routes.', 404)
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      this.broker.store.assertHealthy()
      this.json(response, { status: 'ok', policy: 'no-send', version: 1 })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/execute') {
      if (!execution) throw new BrokerError('private_transport_required', 'Agent execution requires the protected Unix socket.', 404)
      if (!equal(request.headers.authorization ?? '', `Bearer ${this.executorToken}`)) throw new BrokerError('unauthorized', 'A valid execution credential is required.', 401)
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new BrokerError('unsupported_content_type', 'Send application/json.', 415)
      let value: unknown
      try { value = JSON.parse(await this.body(request)) } catch (error) {
        if (error instanceof BrokerError) throw error
        throw new BrokerError('invalid_json', 'Send a valid JSON request.')
      }
      this.json(response, await this.broker.execute(value))
      return
    }
    const browser = this.browser(request)
    if (request.method === 'GET' && url.pathname === '/admin') {
      this.html(response, browser === undefined ? loginPage() : homePage(this.broker.store.state, browser.session.csrf))
      return
    }
    if (request.method === 'POST' && url.pathname === '/admin/login') {
      this.origin(request)
      const fields = await this.form(request)
      if (!equal(fields.get('token') ?? '', this.adminToken)) throw new BrokerError('unauthorized', 'The administrator credential is invalid.', 401)
      for (const [key, value] of this.sessions) if (value.expiresAt <= Date.now()) this.sessions.delete(key)
      if (this.sessions.size >= 32) throw new BrokerError('admin_sessions_full', 'Sign out an earlier administrative browser or wait for its session to expire.', 429)
      const token = randomBytes(32).toString('base64url')
      this.sessions.set(digest(token), { csrf: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 8 * 3_600_000 })
      response.setHeader('Set-Cookie', this.cookie(token, 8 * 3600))
      this.redirect(response, '/admin')
      return
    }
    if (browser === undefined) throw new BrokerError('admin_required', 'Sign in to the separate administrative console.', 401)
    if (request.method === 'GET' && (url.pathname === '/oauth/callback/google' || url.pathname === '/oauth/callback/microsoft')) {
      const provider = url.pathname.endsWith('/google') ? 'google' : 'microsoft'
      await this.broker.serial(async () => this.oauth.complete(
        provider, url.searchParams.get('state') ?? '', url.searchParams.get('code') ?? '', browser.id,
      ))
      this.redirect(response, '/admin')
      return
    }
    if (request.method === 'GET' && url.pathname === '/admin/resources') {
      const connection = this.connection(url.searchParams.get('connectionId'))
      const discovered = await this.broker.serial(async () => this.resources(connection))
      this.html(response, resourcesPage(connection, discovered.resources, browser.session.csrf,
        this.options.maxGrantLifetimeMs / 3_600_000, discovered.truncated))
      return
    }
    if (request.method !== 'POST' || !url.pathname.startsWith('/admin/')) throw new BrokerError('route_denied', 'This broker route is not available.', 404)
    this.origin(request)
    const fields = await this.form(request)
    if (!equal(fields.get('csrf') ?? '', browser.session.csrf)) throw new BrokerError('csrf_rejected', 'Reload the administrative page before submitting this form.', 403)
    if (url.pathname === '/admin/logout') {
      this.sessions.delete(browser.id)
      response.setHeader('Set-Cookie', this.cookie('', 0))
      this.redirect(response, '/admin')
      return
    }
    if (url.pathname === '/admin/oauth/start') {
      const provider = z.enum(['google', 'microsoft']).parse(fields.get('provider'))
      const mode = z.enum(['read', 'write']).parse(fields.get('mode'))
      const existing = fields.get('connectionId')
      const target = await this.broker.serial(async () => this.oauth.begin(
        provider, mode === 'write', browser.id, existing === null ? undefined : this.connection(existing).id,
      ))
      this.html(response, page('Provider consent', `<p><a href="${escapeHtml(target)}">Continue to ${provider === 'google' ? 'Google' : 'Microsoft'} account consent</a></p><p>After consent, choose resource limits and grant the intended Session access.</p>`))
      return
    }
    const changePolicy = async () => {
      this.broker.store.assertHealthy()
      const connection = this.connection(fields.get('connectionId'))
      const state = this.broker.store.state
      switch (url.pathname) {
        case '/admin/toggle': connection.enabled = z.enum(['true', 'false']).parse(fields.get('enabled')) === 'true'; break
        case '/admin/disconnect':
          state.connections = state.connections.filter(item => item.id !== connection.id)
          state.grants = state.grants.filter(item => item.connectionId !== connection.id)
          break
        case '/admin/revoke':
          state.grants = state.grants.filter(item => item.connectionId !== connection.id || item.sessionId !== fields.get('sessionId'))
          break
        case '/admin/policy': {
          const discovered = await this.resources(connection)
          const ids = fields.getAll('resource')
          const capabilities = z.array(capabilitySchema).max(5).parse(fields.getAll('capability'))
          if (capabilities.some(capability => !consentCapabilities(connection).includes(capability))
            || ids.some(id => !discovered.resources.some(resource => resource.id === id))) {
            throw new BrokerError('invalid_policy', 'Select discovered resources and permissions covered by provider consent.')
          }
          connection.resources = discovered.resources.filter(resource => ids.includes(resource.id)).map(resource => ({
            ...resource, capabilities: capabilities.filter(capability => capability.startsWith(resource.id === 'mailbox' ? 'mail.' : 'calendar.')),
          }))
          break
        }
        case '/admin/grant': {
          const hours = z.coerce.number().positive().max(this.options.maxGrantLifetimeMs / 3_600_000).parse(fields.get('hours'))
          const grant = grantSchema.parse({ sessionId: fields.get('sessionId'), connectionId: connection.id, resources: fields.getAll('resource'), capabilities: fields.getAll('capability'), expiresAt: Date.now() + Math.floor(hours * 3_600_000) })
          validateGrant(state, grant, this.options.maxGrantLifetimeMs)
          state.grants = state.grants.filter(item => item.connectionId !== grant.connectionId || item.sessionId !== grant.sessionId)
          state.grants.push(grant)
          break
        }
        case '/admin/calendar/create': {
          if (!consentCapabilities(connection).includes('calendar.write')) throw new BrokerError('write_consent_required', 'Reconnect this account with write consent before creating a calendar.', 403)
          const name = z.string().min(1).max(200).parse(fields.get('name'))
          const http = this.broker.provider(connection)
          if (connection.provider === 'google') await http.json('POST', '/calendar/v3/calendars', { summary: name })
          else await http.json('POST', '/v1.0/me/calendars', { name })
          break
        }
        default: throw new BrokerError('route_denied', 'This administrative action is not available.', 404)
      }
      this.broker.store.save()
      this.broker.store.audit('administrator', connection.id, url.pathname, 'succeeded')
    }
    if (['/admin/toggle', '/admin/disconnect', '/admin/revoke', '/admin/grant'].includes(url.pathname)) {
      await changePolicy()
    } else await this.broker.serial(changePolicy)
    this.redirect(response, '/admin')
  }

  private async resources(connection: Connection): Promise<{ resources: ResourcePolicy[]; truncated: boolean }> {
    const http = this.broker.provider(connection)
    const google = connection.provider === 'google'
    const result = await http.json('GET', google ? '/calendar/v3/users/me/calendarList?maxResults=200' : '/v1.0/me/calendars?$top=199')
    const items = google ? result.items : result.value
    if (!Array.isArray(items)) throw new BrokerError('provider_data_invalid', 'The provider did not return a calendar list.', 502)
    const resources = items.map((value) => {
      const item = object(value)
      return resourcePolicySchema.parse({ id: item.id, label: google ? item.summary : item.name, capabilities: [] })
    })
    if (!google) resources.push(resourcePolicySchema.parse({ id: 'mailbox', label: 'Outlook mailbox', capabilities: [] }))
    return { resources, truncated: typeof result.nextPageToken === 'string' || typeof result['@odata.nextLink'] === 'string' }
  }

  private connection(id: string | null): Connection {
    const result = this.broker.store.state.connections.find(connection => connection.id === id)
    if (result === undefined) throw new BrokerError('connection_unavailable', 'Choose an existing connected account.', 404)
    return result
  }

  private browser(request: IncomingMessage): { id: string; session: AdminSession } | undefined {
    const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('mydot_admin='))?.slice('mydot_admin='.length)
    if (token === undefined) return undefined
    const id = digest(token)
    const session = this.sessions.get(id)
    if (session === undefined || session.expiresAt <= Date.now()) { this.sessions.delete(id); return undefined }
    return { id, session }
  }

  private origin(request: IncomingMessage): void {
    if (request.headers.origin !== this.options.publicOrigin) throw new BrokerError('origin_rejected', 'Open the configured administrative URL before submitting a form.', 403)
  }

  private async body(request: IncomingMessage): Promise<string> {
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      bytes += buffer.length
      if (bytes > this.options.maxBodyBytes) throw new BrokerError('request_too_large', 'Reduce the request content.', 413)
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private async form(request: IncomingMessage): Promise<URLSearchParams> {
    if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new BrokerError('unsupported_content_type', 'Submit the administrative HTML form.', 415)
    return new URLSearchParams(await this.body(request))
  }

  private cookie(value: string, seconds: number): string {
    return `mydot_admin=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.options.publicOrigin.startsWith('https:') ? '; Secure' : ''}`
  }

  private redirect(response: ServerResponse, location: string): void { response.writeHead(303, { Location: location }); response.end() }
  private json(response: ServerResponse, value: unknown): void { response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)) }
  private html(response: ServerResponse, value: string): void { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(value) }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function equal(left: string, right: string): boolean { return timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right))) }
