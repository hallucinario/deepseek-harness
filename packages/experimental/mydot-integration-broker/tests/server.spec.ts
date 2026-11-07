import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerOAuth } from '../src/oauth.ts'
import { BrokerServer } from '../src/server.ts'
import { BrokerStore } from '../src/store.ts'
import { fixture, google, googleResponder, key, request, transportFixture } from './support.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()?.() })
const executor = 'executor-credential-'.repeat(3)
const administrator = 'administrator-credential-'.repeat(3)
const origin = 'http://127.0.0.1:0'
const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }

async function serverFixture() {
  const upstream = transportFixture(call => call.url.pathname === '/calendar/v3/users/me/calendarList' ? { items: [{ id: 'calendar-a', summary: 'Personal' }] } : googleResponder(call))
  const setup = await fixture('google', upstream.transport)
  const server = new BrokerServer(setup.broker, { begin: async () => 'https://accounts.google.com/o/oauth2/v2/auth?state=test', complete: async () => google().id },
    { host: '127.0.0.1', port: 0, publicOrigin: origin, maxBodyBytes: 8192, requestTimeoutMs: 10_000, maxGrantLifetimeMs: 3_600_000 }, executor, administrator)
  await server.listen()
  cleanup.push(async () => { await server.close(); await setup.close() })
  return { ...setup, server, base: `http://127.0.0.1:${server.port()}`, upstream }
}

async function login(base: string) {
  const result = await fetch(base + '/admin/login', { method: 'POST', headers, body: new URLSearchParams({ token: administrator }), redirect: 'manual' })
  expect(result.status).toBe(303)
  const cookie = result.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined) throw new Error('missing administrative cookie')
  const home = await fetch(base + '/admin', { headers: { Cookie: cookie } })
  const html = await home.text()
  const csrf = /name="csrf" value="([^"]+)"/u.exec(html)?.[1]
  if (csrf === undefined) throw new Error('missing administrative anti-forgery value')
  return { cookie, csrf, html }
}

describe.skipIf(process.platform === 'win32')('isolated broker HTTP authentication', () => {
  it('separates execution and human credentials without leaking account metadata', async () => {
    const setup = await serverFixture()
    const body = JSON.stringify(request('calendar.get', { eventId: 'event-a' }))
    const denied = await fetch(setup.base + '/v1/execute', { method: 'POST', headers: { Authorization: `Bearer ${administrator}`, 'Content-Type': 'application/json' }, body })
    expect(denied.status).toBe(404)
    const adminDenied = await fetch(setup.base + '/admin/resources?connectionId=google-a', { headers: { Authorization: `Bearer ${executor}` } })
    expect(adminDenied.status).toBe(401)
    expect(await adminDenied.text()).not.toContain('Personal Google')
    const allowed = await fetch(setup.base + '/v1/execute', { method: 'POST', headers: { Authorization: `Bearer ${executor}`, 'Content-Type': 'application/json' }, body })
    expect(allowed.status).toBe(404)
    expect(await allowed.json()).toMatchObject({ ok: false, error: { code: 'private_transport_required' } })
    expect(setup.upstream.calls).toHaveLength(0)
  })

  it('requires the configured Origin and per-browser anti-forgery value for administrative mutations', async () => {
    const setup = await serverFixture()
    const badLogin = await fetch(setup.base + '/admin/login', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: new URLSearchParams({ token: administrator }) })
    expect(badLogin.status).toBe(403)
    const browser = await login(setup.base)
    const denied = await fetch(setup.base + '/admin/toggle', { method: 'POST', headers: { ...headers, Cookie: browser.cookie }, body: new URLSearchParams({ connectionId: 'google-a', csrf: 'wrong' }) })
    expect(denied.status).toBe(403)
    expect(setup.connection.enabled).toBe(true)
    const changed = await fetch(setup.base + '/admin/toggle', { method: 'POST', headers: { ...headers, Cookie: browser.cookie }, body: new URLSearchParams({ connectionId: 'google-a', enabled: 'false', csrf: browser.csrf }), redirect: 'manual' })
    expect(changed.status).toBe(303)
    expect(setup.connection.enabled).toBe(false)
    const repeated = await fetch(setup.base + '/admin/toggle', {
      method: 'POST', headers: { ...headers, Cookie: browser.cookie }, redirect: 'manual',
      body: new URLSearchParams({ connectionId: 'google-a', enabled: 'false', csrf: browser.csrf }),
    })
    expect(repeated.status).toBe(303)
    expect(setup.connection.enabled).toBe(false)
    expect(await setup.broker.execute(request('calendar.get', { eventId: 'event-a' }))).toMatchObject({ ok: false, error: { code: 'connection_unavailable' } })
  })

  it('escapes provider names and exposes no token material in the administrative page', async () => {
    const setup = await serverFixture()
    setup.connection.label = '<script>bad()</script>'
    const browser = await login(setup.base)
    expect(browser.html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(browser.html).not.toContain('<script>')
    expect(browser.html).not.toContain('private-google-refresh-token')
    expect(browser.html).not.toContain(executor)
    expect(browser.html).not.toContain(administrator)
    const home = await fetch(setup.base + '/admin', { headers: { Cookie: browser.cookie } })
    expect(home.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(home.headers.get('cache-control')).toBe('no-store')
  })

  it('persists explicit resource limits and an expiring exact-Session grant, then revokes it', async () => {
    const setup = await serverFixture()
    const browser = await login(setup.base)
    const form = async (path: string, values: Record<string, string>) => fetch(setup.base + path, { method: 'POST', headers: { ...headers, Cookie: browser.cookie }, body: new URLSearchParams({ csrf: browser.csrf, connectionId: 'google-a', ...values }), redirect: 'manual' })
    expect((await form('/admin/policy', { resource: 'calendar-a', capability: 'calendar.read' })).status).toBe(303)
    expect(setup.connection.resources[0]!.capabilities).toEqual(['calendar.read'])
    expect((await form('/admin/grant', { sessionId: 'new-session', resource: 'calendar-a', capability: 'calendar.read', hours: '0.25' })).status).toBe(303)
    expect(await setup.broker.execute({ ...request('calendar.get', { eventId: 'event-a' }), sessionId: 'new-session' })).toMatchObject({ ok: true })
    expect((await form('/admin/revoke', { sessionId: 'new-session' })).status).toBe(303)
    expect(await setup.broker.execute({ ...request('calendar.get', { eventId: 'event-a' }), sessionId: 'new-session' })).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  })

  it('rejects a shared administrator/executor secret', async () => {
    const setup = await fixture('google', transportFixture(googleResponder).transport)
    cleanup.push(() => setup.close())
    expect(() => new BrokerServer(setup.broker, { begin: async () => '', complete: async () => google().id },
      { host: '127.0.0.1', port: 0, publicOrigin: origin, maxBodyBytes: 8192, requestTimeoutMs: 10_000, maxGrantLifetimeMs: 3600_000 }, executor, executor)).toThrow('must differ')
  })
})

describe.skipIf(process.platform === 'win32')('OAuth authorization state', () => {
  it('uses PKCE, fixed redirect, account selection, state and nonce, and consumes mismatched browser state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mydot-oauth-'))
    const store = new BrokerStore(join(directory, 'state'), key)
    cleanup.push(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
    const configuration = join(directory, 'oauth.json')
    await writeFile(configuration, JSON.stringify({ google: { clientId: 'fixture-client', clientSecret: 'fixture-secret' } }), { mode: 0o600 })
    const oauth = new BrokerOAuth(store, 'https://broker.example', configuration, { requestTimeoutMs: 10_000, maxResponseBytes: 100_000 })
    const url = new URL(await oauth.begin('google', true, 'browser-a', undefined))
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('redirect_uri')).toBe('https://broker.example/oauth/callback/google')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toHaveLength(43)
    expect(url.searchParams.get('nonce')).toBeTruthy()
    expect(url.searchParams.get('prompt')).toContain('select_account')
    expect(url.searchParams.get('include_granted_scopes')).toBe('false')
    expect(url.searchParams.get('scope')).not.toContain('gmail')
    const state = url.searchParams.get('state')!
    await expect(oauth.complete('google', state, 'unused-code', 'browser-b')).rejects.toMatchObject({ code: 'invalid_oauth_state' })
    await expect(oauth.complete('google', state, 'unused-code', 'browser-a')).rejects.toMatchObject({ code: 'invalid_oauth_state' })
    expect(store.state.connections).toEqual([])
  })
})
