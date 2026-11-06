import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeListener, listenExecutor } from '../src/executor-listener.ts'
import { BrokerServer } from '../src/server.ts'
import { fixture, google, googleResponder, request, transportFixture } from './support.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()?.() })

async function socketDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mydot-socket-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function call(socketPath: string, path: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ socketPath, path, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }) })
      response.on('error', reject)
    })
    outgoing.on('error', reject)
    outgoing.end(JSON.stringify(request('calendar.get', { eventId: 'event-a' })))
  })
}

describe.skipIf(process.platform === 'win32')('private Unix execution transport', () => {
  it('refuses replaceable directories and preserves an unknown existing file', async () => {
    const directory = await socketDirectory()
    const socketPath = join(directory, 'execute.sock')
    const server = createServer()
    await chmod(directory, 0o770)
    await expect(listenExecutor(server, socketPath)).rejects.toThrow('without group write')
    await chmod(directory, 0o700)
    await writeFile(socketPath, 'operator data', { mode: 0o600 })
    await expect(listenExecutor(server, socketPath)).rejects.toThrow('unknown execution socket path')
    expect(await readFile(socketPath, 'utf8')).toBe('operator data')
    expect(server.listening).toBe(false)
  })

  it('authenticates execution over a protected socket and exposes no administration on that socket', async (test) => {
    const directory = await socketDirectory()
    const executorSocketPath = join(directory, 'execute.sock')
    const setup = await fixture('google', transportFixture(googleResponder).transport)
    const executor = 'executor-credential-'.repeat(3)
    const admin = 'administrator-credential-'.repeat(3)
    const server = new BrokerServer(setup.broker,
      { begin: async () => 'https://accounts.google.com', complete: async () => google().id },
      { host: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1:0', maxBodyBytes: 8192,
        requestTimeoutMs: 10_000, maxGrantLifetimeMs: 3_600_000, executorSocketPath }, executor, admin)
    cleanup.push(async () => { await server.close(); await setup.close() })
    try { await server.listen() }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM' && 'syscall' in error && error.syscall === 'listen') {
        test.skip('This execution environment prohibits Unix-domain listeners; the test runs on normal POSIX CI workers.')
      }
      throw error
    }
    expect((await lstat(executorSocketPath)).mode & 0o777).toBe(0o660)
    expect((await call(executorSocketPath, '/v1/execute', admin)).status).toBe(401)
    const allowed = await call(executorSocketPath, '/v1/execute', executor)
    expect(allowed.status).toBe(200)
    expect(JSON.parse(allowed.body)).toMatchObject({ ok: true, connectionId: 'google-a' })
    expect((await call(executorSocketPath, '/admin', executor)).status).toBe(404)
    const other = createServer()
    cleanup.push(() => closeListener(other))
    await expect(listenExecutor(other, executorSocketPath)).rejects.toThrow('Another broker')
    await server.close()
    await expect(lstat(executorSocketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
