/** Keyless real Unix HTTP probe, executed by the POSIX e2e lane. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerClient } from '../src/transport.ts'
import { resolveConfig } from '../src/config.ts'
import { requestFor } from '../src/input.ts'
import { TOKEN } from './harness.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe.skipIf(process.platform === 'win32')('MyDot real Unix HTTP', () => {
  it('uses the protected executor socket without a TCP listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mydot-unix-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const executorTokenFile = join(root, 'token')
    const executorSocketPath = join(root, 'executor.sock')
    await writeFile(executorTokenFile, TOKEN, { mode: 0o600 })
    const received: string[] = []
    const server = createServer((request, response) => {
      received.push(request.headers.authorization ?? '')
      request.resume()
      request.once('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ version: 1, ok: true, operation: 'connections.list', data: { connections: [] }, warnings: [] }))
      })
    })
    cleanups.push(async () => {
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
        server.closeAllConnections()
      })
    })
    server.listen(executorSocketPath)
    await once(server, 'listening')
    const client = new BrokerClient(resolveConfig({ brokerUrl: 'https://console.invalid', executorTokenFile, executorSocketPath }))
    cleanups.push(() => client.dispose())
    const result = await client.execute(requestFor('connections.list', { arguments: {} }, 'unix-session', 'unix-call'), new AbortController().signal)
    expect(result).toMatchObject({ ok: true, operation: 'connections.list' })
    expect(received).toEqual([`Bearer ${TOKEN}`])
  })
})
