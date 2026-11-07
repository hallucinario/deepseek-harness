/** Resource-owned HTTP fixture replacing only the external broker boundary. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrokerRequest } from '@deepseek-ai/dsh-experimental-mydot-integration-broker/types'
import { resolveConfig, type Config } from '../src/config.ts'
import { BrokerClient } from '../src/transport.ts'

/** One intercepted authenticated request. */
export interface SeenRequest {
  request: BrokerRequest
  authorization: string | undefined
  method: string | undefined
  url: string | undefined
}

/** Safe high-entropy-shaped fixture token, never a live credential. */
export const TOKEN = 'mydot-executor-fixture-token-000000000000000000000'

/**
 * Start an ephemeral broker and private credential with explicit async teardown.
 * @param cleanups - Caller cleanup stack, registered before each acquisition is used.
 * @param reply - Deterministic external broker behavior.
 * @param overrides - Optional bounded transport settings.
 * @returns The real HTTP client and captured requests.
 */
export async function fixture(
  cleanups: Array<() => Promise<void>>,
  reply: (seen: SeenRequest, response: ServerResponse, raw: IncomingMessage) => void,
  overrides: Partial<Config> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mydot-client-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const executorTokenFile = join(root, 'executor.token')
  await writeFile(executorTokenFile, TOKEN, { mode: 0o600 })
  const requests: SeenRequest[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      const seen = {
        request: JSON.parse(body) as BrokerRequest, authorization: req.headers.authorization, method: req.method, url: req.url,
      }
      requests.push(seen)
      reply(seen, res, req)
    })
  })
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture has no bound TCP port')
  const config = resolveConfig({ brokerUrl: `http://127.0.0.1:${address.port}`, executorTokenFile, ...overrides })
  const client = new BrokerClient(config)
  cleanups.push(() => client.dispose())
  return { root, config, client, requests }
}

/** @param response - Fixture HTTP response. @param value - Safe JSON response. @param status - HTTP status. */
export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

/** @param request - Observed request. @param data - Fixture provider data. @returns Matched successful envelope. */
export function success(request: BrokerRequest, data: unknown = { items: [] }) {
  return { version: 1, ok: true, operation: request.operation, connectionId: request.connectionId,
    resourceId: request.resourceId, requestId: request.requestId, accountLabel: 'Test account', data, warnings: [] }
}
