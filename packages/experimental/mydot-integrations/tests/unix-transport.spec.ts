/** The HTTP peer remains real; injection replaces only the unavailable Unix connect boundary. */
import http from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerClient } from '../src/transport.ts'
import { requestFor } from '../src/input.ts'
import { resolveConfig } from '../src/config.ts'
import { fixture, json, success, TOKEN } from './harness.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const signal = (): AbortSignal => new AbortController().signal
const request = () => requestFor('connections.list', { arguments: {} }, 'unix-session', 'unix-call')

describe('MyDot protected socket transport', () => {
  it('selects socketPath, preserves authentication and never uses the console origin as an executor', async () => {
    const f = await fixture(cleanups, (seen, res) => { json(res, success(seen.request)) })
    const target = new URL(f.config.brokerUrl)
    const socketPath = join(f.root, 'broker.sock')
    const seen: http.RequestOptions[] = []
    const client = new BrokerClient({ ...f.config, brokerUrl: 'https://console.invalid', executorSocketPath: socketPath }, (options, response) => {
      seen.push(options)
      const { socketPath: _socketPath, ...network } = options
      return http.request({ ...network, hostname: target.hostname, port: target.port }, response)
    })
    cleanups.push(() => client.dispose())
    expect(await client.execute(request(), signal())).toMatchObject({ ok: true, operation: 'connections.list' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ socketPath, path: '/v1/execute', method: 'POST', agent: false, headers: { authorization: `Bearer ${TOKEN}` } })
    expect(seen[0]!.hostname).toBeUndefined()
    expect(f.requests).toHaveLength(1)
  })

  it('fails closed when the configured socket is missing, without sending a bearer to the TCP console', async () => {
    const f = await fixture(cleanups, (seen, res) => { json(res, success(seen.request)) })
    const client = new BrokerClient({ ...f.config, executorSocketPath: join(f.root, 'absent.sock') })
    cleanups.push(() => client.dispose())
    expect(await client.execute(request(), signal())).toMatchObject({ ok: false, error: { retryable: false } })
    expect(f.requests).toHaveLength(0)
  })

  it('bounds the Node HTTP response and does not follow a socket redirect', async () => {
    for (const oversized of [false, true]) {
      const f = await fixture(cleanups, (seen, res) => {
        if (oversized) json(res, success(seen.request, '界'.repeat(1000)))
        else { res.writeHead(307, { location: '/admin' }); res.end() }
      }, { maxResultBytes: 512 })
      const target = new URL(f.config.brokerUrl)
      const client = new BrokerClient({ ...f.config, executorSocketPath: join(f.root, 'broker.sock') }, (options, response) => {
        const { socketPath: _socketPath, ...network } = options
        return http.request({ ...network, hostname: target.hostname, port: target.port }, response)
      })
      cleanups.push(() => client.dispose())
      expect(await client.execute(request(), signal())).toMatchObject({ ok: false, error: { outcome: 'unknown', retryable: false } })
      expect(f.requests).toHaveLength(1)
    }
  })

  it('aborts an unfinished socket response and joins request close on disposal', async () => {
    const entered = Promise.withResolvers<undefined>()
    const f = await fixture(cleanups, (_seen, res) => { res.writeHead(200); res.write('{'); entered.resolve(undefined) })
    const target = new URL(f.config.brokerUrl)
    let closed = false
    const client = new BrokerClient({ ...f.config, executorSocketPath: join(f.root, 'broker.sock') }, (options, response) => {
      const { socketPath: _socketPath, ...network } = options
      const req = http.request({ ...network, hostname: target.hostname, port: target.port }, response)
      req.once('close', () => { closed = true })
      return req
    })
    cleanups.push(() => client.dispose())
    const pending = client.execute(request(), signal())
    await entered.promise
    await client.dispose()
    expect(closed).toBe(true)
    expect(await pending).toMatchObject({ ok: false, error: { outcome: 'unknown', code: 'request_cancelled' } })
  })

  it('rejects an empty or relative socket path instead of silently using HTTP', () => {
    for (const executorSocketPath of ['', 'relative/broker.sock']) {
      expect(() => resolveConfig({ brokerUrl: 'http://127.0.0.1:18790', executorTokenFile: '/private/token', executorSocketPath })).toThrow()
    }
  })
})
