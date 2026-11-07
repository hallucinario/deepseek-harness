import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Configuration, INetworkModule } from '@azure/msal-node'
import { OAuth2Client } from 'google-auth-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrokerOAuth, type OAuthNetworkOptions } from '../src/oauth.ts'
import { BrokerStore } from '../src/store.ts'
import { google, key } from './support.ts'

const sdk = vi.hoisted(() => ({ microsoftConfigurations: [] as Configuration[] }))
vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    constructor(configuration: Configuration) { sdk.microsoftConfigurations.push(configuration) }
    async getAuthCodeUrl() { return 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' }
  },
}))

const cleanup: Array<() => Promise<void>> = []
// Select the Promise overload; the SDK also exposes a callback overload returning void.
const tokenMethods: { getAccessToken: () => Promise<{ token?: string | null }> } = OAuth2Client.prototype
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sdk.microsoftConfigurations.length = 0
  while (cleanup.length > 0) await cleanup.pop()?.()
})

async function oauthFixture(options: OAuthNetworkOptions = { requestTimeoutMs: 50, maxResponseBytes: 256 }) {
  const directory = await mkdtemp(join(tmpdir(), 'mydot-oauth-network-'))
  const store = new BrokerStore(join(directory, 'state'), key)
  cleanup.push(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  const configuration = join(directory, 'oauth.json')
  await writeFile(configuration, JSON.stringify({
    google: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
    microsoft: { clientId: 'fixture-client', clientSecret: 'fixture-secret', tenant: 'common' },
  }), { mode: 0o600 })
  return { store, oauth: new BrokerOAuth(store, 'https://broker.example', configuration, options) }
}

async function microsoftNetwork(options?: OAuthNetworkOptions): Promise<INetworkModule> {
  const setup = await oauthFixture(options)
  await setup.oauth.begin('microsoft', false, 'browser-a', undefined)
  const network = sdk.microsoftConfigurations.at(-1)?.system?.networkClient
  if (network === undefined) throw new Error('Microsoft SDK did not receive its bounded network client')
  return network
}

describe.skipIf(process.platform === 'win32')('OAuth network limits', () => {
  it('overrides Google SDK per-request retry flags and bounds timeout, bytes and redirects', async () => {
    const setup = await oauthFixture({ requestTimeoutMs: 500, maxResponseBytes: 512 })
    let calls = 0
    vi.spyOn(tokenMethods, 'getAccessToken').mockImplementation(async function (this: OAuth2Client) {
      this.transporter.defaults.adapter = async (options) => {
        calls++
        expect(options.retry).toBe(false)
        expect(options.timeout).toBe(500)
        expect(options.maxContentLength).toBe(512)
        expect(options.redirect).toBe('error')
        expect(options.signal).toBeDefined()
        throw new Error('fixture transport failure')
      }
      await this.transporter.request({ url: 'https://oauth2.googleapis.com/token', retry: true })
      return { token: 'unreachable' }
    })
    await expect(setup.oauth.accessToken(google())).rejects.toMatchObject({ code: 'reconnect_required' })
    expect(calls).toBe(1)
  })

  it('aborts a stalled Google token request before any cache persistence can happen', async () => {
    const setup = await oauthFixture()
    const save = vi.spyOn(setup.store, 'save')
    let aborted = false
    vi.spyOn(tokenMethods, 'getAccessToken').mockImplementation(async function (this: OAuth2Client) {
      this.transporter.defaults.adapter = async options => new Promise<never>((_resolve, reject) => {
        const signal = options.signal
        if (signal === undefined || signal === null) throw new Error('Missing Google deadline')
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('OAuth deadline')) }, { once: true })
        if (signal.aborted) { aborted = true; reject(new Error('OAuth deadline')) }
      })
      await this.transporter.request({ url: 'https://oauth2.googleapis.com/token', retry: true })
      return { token: 'unreachable' }
    })
    await expect(setup.oauth.accessToken(google())).rejects.toMatchObject({ code: 'reconnect_required' })
    expect(aborted).toBe(true)
    expect(save).not.toHaveBeenCalled()
  })

  it('permits only the fixed Microsoft identity origin before submitting credentials', async () => {
    const network = await microsoftNetwork()
    const transport = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', transport)
    for (const url of [
      'https://attacker.example/token', 'http://login.microsoftonline.com/token',
      'https://user:password@login.microsoftonline.com/token', 'https://login.microsoftonline.com/token#fragment',
    ]) {
      await expect(network.sendPostRequestAsync(url, { body: 'client_secret=fixture' }))
        .rejects.toMatchObject({ code: 'oauth_endpoint_denied' })
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('passes SDK headers and form data with redirect rejection and a bounded JSON response', async () => {
    const network = await microsoftNetwork({ requestTimeoutMs: 500, maxResponseBytes: 256 })
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: 'fixture' }))
    vi.stubGlobal('fetch', transport)
    const result = await network.sendPostRequestAsync<{ access_token: string }>(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'client_secret=fixture' },
    )
    expect(result.body).toEqual({ access_token: 'fixture' })
    expect(result.status).toBe(200)
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST', redirect: 'error', body: 'client_secret=fixture',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    expect(transport.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects oversized Microsoft token bodies even without a Content-Length header', async () => {
    const network = await microsoftNetwork({ requestTimeoutMs: 500, maxResponseBytes: 64 })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(65))))
    await expect(network.sendPostRequestAsync('https://login.microsoftonline.com/common/oauth2/v2.0/token'))
      .rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('cancels Microsoft header waits and shares the deadline across SDK discovery and token requests', async () => {
    const network = await microsoftNetwork()
    let shared: AbortSignal | null | undefined
    let calls = 0
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, options) => {
      calls++
      if (calls === 1) { shared = options?.signal; return Response.json({ metadata: 'fixture' }) }
      expect(options?.signal).toBe(shared)
      const signal = options?.signal
      if (signal === undefined || signal === null) throw new Error('Missing Microsoft deadline')
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error ? reason : new DOMException('OAuth deadline', 'TimeoutError'))
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }))
    await network.sendGetRequestAsync('https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration')
    await expect(network.sendPostRequestAsync('https://login.microsoftonline.com/common/oauth2/v2.0/token'))
      .rejects.toMatchObject({ name: 'TimeoutError' })
    expect(shared?.aborted).toBe(true)
  })
})
