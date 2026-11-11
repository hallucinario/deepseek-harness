/** Real local Unix HTTP callback, bounded input and protected listener lifecycle. */
import http from 'node:http'
import { Stats } from 'node:fs'
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http'
import { createServer, createConnection, Socket } from 'node:net'
import { chmod, lstat, mkdtemp, realpath, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HumanHandoffListener, readHandoffJson } from '../src/human-handoff-transport.ts'
import { humanRequestSchema, surveyResultSchema } from '../src/human-handoff-state.ts'
import type { HumanHandoffConfig } from '../src/human-handoff.ts'
import type { HumanRequestView } from '../src/types.ts'

const close: Array<() => Promise<void>> = []
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), chmod: vi.fn(actual.chmod) }
})
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>()
  return { ...actual, createConnection: vi.fn(actual.createConnection) }
})
vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})
afterEach(async () => {
  vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  await Promise.all(close.splice(0).map(dispose => dispose()))
})
const result = surveyResultSchema.parse({ schemaVersion: 1, requestId: 'public-review', status: 'saved',
  source: { caseId: 'public-case', sourceId: 'source', sourceRevision: 'a'.repeat(64), manifestId: 'b'.repeat(64) },
  baseSurvey: { revisionId: 'c'.repeat(64), version: 1 }, survey: { revisionId: 'd'.repeat(64), version: 2 }, planning: null, goldId: null })
const view: HumanRequestView = { phase: 'queued', request: humanRequestSchema.parse({ requestId: result.requestId, requestRevision: 1,
  sessionId: 'original', parentSessionId: null, question: 'Review?', reason: 'Independent review', role: 'owner', evidenceUrl: '',
  resumeInstruction: 'Continue', options: [], target: null, goal: null }) }
async function config(): Promise<HumanHandoffConfig & { humanHandoffTimeoutMs: number }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-human-unix-')))
  return { humanHandoffEnabled: true, humanHandoffSocketPath: join(root, 'callback.sock'), humanHandoffSurveyOrigin: 'http://127.0.0.1:3211',
    humanHandoffTimeoutMs: 1000, maxTextBytes: 4096 }
}
function post(socketPath: string, body: string, path = '/human-requests/public-review/answers', method = 'POST', contentType: string | null = 'application/json'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path, method, headers: contentType === null ? {} : { 'content-type': contentType } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Uint8Array) => { chunks.push(Buffer.from(chunk)) })
      response.once('error', reject)
      response.once('end', () => { resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    request.once('error', reject)
    request.end(body)
  })
}

it('bounds complete UTF-8 JSON bodies and rejects malformed payloads', async () => {
  async function* chunks(value: Uint8Array | string) { yield value }
  expect(await readHandoffJson(chunks('{"text":"日本語"}'), 100)).toEqual({ text: '日本語' })
  await expect(readHandoffJson(chunks('{"text":"日本語"}'), 10)).rejects.toThrow('byte allowance')
  await expect(readHandoffJson(chunks('not json'), 100)).rejects.toThrow()
  await expect(readHandoffJson(chunks(new Uint8Array([0xff])), 100)).rejects.toThrow()
})

describe.skipIf(process.platform === 'win32')('owner Unix callback', () => {
  it('contains a response transport failure after headers and rejects a missing request target', async () => {
    const options = await config()
    const accept = vi.fn(async () => view)
    const listener = new HumanHandoffListener(options, accept)
    const registered = vi.mocked(createHttpServer).mock.results.at(-1)!
    if (registered.type !== 'return') throw new Error('The listener must own the Node HTTP server')
    const request = new IncomingMessage(new Socket())
    request.method = 'POST'; request.url = '/human-requests/public-review/answers'; request.headers = { 'content-type': 'application/json' }
    request.push(Buffer.from(JSON.stringify({ requestRevision: 1, result }))); request.push(null)
    const response = new ServerResponse(request)
    vi.spyOn(response, 'end').mockImplementationOnce(() => { throw new Error('response transport failed') })
    const headers = vi.spyOn(response, 'writeHead')
    registered.value.emit('request', request, response)
    await listener.close()
    expect(accept).toHaveBeenCalledOnce()
    expect(headers).toHaveBeenCalledExactlyOnceWith(200, expect.any(Object))
    const noTarget = new IncomingMessage(new Socket())
    noTarget.method = 'POST'
    Reflect.deleteProperty(noTarget, 'url')
    const rejected = new ServerResponse(noTarget)
    const rejectHead = vi.spyOn(rejected, 'writeHead')
    registered.value.emit('request', noTarget, rejected)
    await listener.close()
    expect(rejectHead).toHaveBeenCalledExactlyOnceWith(404)
  })

  it('reports failure to close its server and allows the owner to finish cleanup', async () => {
    const options = await config()
    const listener = new HumanHandoffListener(options, async () => view)
    close.push(() => listener.close())
    await listener.listen()
    const created = vi.mocked(createHttpServer).mock.results.at(-1)!
    if (created.type !== 'return') throw new Error('The Node server must be created')
    const server = created.value
    vi.spyOn(server, 'close').mockImplementationOnce((callback) => { callback?.(new Error('server close failed')); return server })
    await expect(listener.close()).rejects.toThrow('server close failed')
    await listener.close()
  })
  async function staleSocket(path: string) {
    const server = createServer()
    await new Promise<void>((resolve) => { server.listen(path, resolve) })
    const retained = `${path}.retained`
    await rename(path, retained)
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    await rename(retained, path)
  }

  it('preserves a stale socket under a retired name before opening its own inode', async () => {
    const options = await config()
    await staleSocket(options.humanHandoffSocketPath)
    const original = await lstat(options.humanHandoffSocketPath)
    const listener = new HumanHandoffListener(options, async () => view)
    close.push(() => listener.close())
    await listener.listen()
    const retained = (await readdir(join(options.humanHandoffSocketPath, '..'))).find(name => name.includes('.tobedeleted-'))
    expect(retained).toBeDefined()
    expect((await lstat(join(options.humanHandoffSocketPath, '..', retained!))).ino).toBe(original.ino)
    expect((await lstat(options.humanHandoffSocketPath)).ino).not.toBe(original.ino)
  })

  it('does not replace a stale socket when ownership probing times out or reports an unexpected error', async () => {
    const options = await config()
    await staleSocket(options.humanHandoffSocketPath)
    const original = await lstat(options.humanHandoffSocketPath)
    for (const failure of ['timeout', 'error-with-code', 'error-without-code'] as const) {
      vi.mocked(createConnection).mockImplementationOnce(() => {
        const socket = new Socket()
        queueMicrotask(() => {
          if (failure === 'timeout') socket.emit('timeout')
          else socket.emit('error', failure === 'error-with-code' ? Object.assign(new Error('probe denied'), { code: 'EACCES' }) : new Error('probe failed'))
        })
        return socket
      })
      const listener = new HumanHandoffListener(options, async () => view)
      await expect(listener.listen()).rejects.toThrow(failure === 'timeout' ? 'ownership is unknown' : 'probe')
      expect((await lstat(options.humanHandoffSocketPath)).ino).toBe(original.ino)
    }
  })

  it('refuses changed socket metadata, foreign ownership and filesystem errors without replacement', async () => {
    const options = await config()
    await staleSocket(options.humanHandoffSocketPath)
    const socket = await lstat(options.humanHandoffSocketPath)
    const directory = await lstat(join(options.humanHandoffSocketPath, '..'))
    for (const field of ['ino', 'dev'] as const) {
      vi.mocked(lstat).mockResolvedValueOnce(directory).mockResolvedValueOnce(socket)
        .mockResolvedValueOnce(Object.assign(Object.create(Stats.prototype) as Stats, socket, { [field]: socket[field] + 1 }))
      await expect(new HumanHandoffListener(options, async () => view).listen()).rejects.toThrow('changed during startup')
      expect((await lstat(options.humanHandoffSocketPath)).ino).toBe(socket.ino)
    }
    vi.mocked(lstat).mockResolvedValueOnce(directory)
      .mockResolvedValueOnce(Object.assign(Object.create(Stats.prototype) as Stats, socket, { uid: socket.uid + 1 }))
    await expect(new HumanHandoffListener(options, async () => view).listen()).rejects.toThrow('unknown handoff socket')
    vi.mocked(lstat).mockResolvedValueOnce(directory).mockRejectedValueOnce(new Error('metadata unavailable'))
    await expect(new HumanHandoffListener(options, async () => view).listen()).rejects.toThrow('metadata unavailable')
  })

  it('closes ingress when socket permission publication fails', async () => {
    const options = await config()
    const listener = new HumanHandoffListener(options, async () => view)
    vi.mocked(chmod).mockRejectedValueOnce(new Error('permission publication failed'))
    await expect(listener.listen()).rejects.toThrow('permission publication failed')
    await expect(post(options.humanHandoffSocketPath, '{}')).rejects.toThrow()
    await listener.close()
  })

  it('bounds incomplete request bodies and drains the timed-out operation at shutdown', async () => {
    const options = await config()
    const listener = new HumanHandoffListener({ ...options, humanHandoffTimeoutMs: 20 }, async () => view)
    close.push(() => listener.close())
    await listener.listen()
    const failed = new Promise<Error>((resolve) => {
      const request = http.request({ socketPath: options.humanHandoffSocketPath, path: '/human-requests/public-review/answers', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': 100 } })
      request.on('error', resolve)
      request.write('{')
    })
    expect((await failed).message).toContain('socket hang up')
    await listener.close()
  })
  it('uses an owner-only socket and acknowledges one exact server result', async () => {
    const options = await config()
    const accept = vi.fn(async () => view)
    const listener = new HumanHandoffListener(options, accept)
    close.push(() => listener.close())
    await listener.listen()
    expect((await lstat(options.humanHandoffSocketPath)).mode & 0o777).toBe(0o600)
    const response = await post(options.humanHandoffSocketPath, JSON.stringify({ requestRevision: 1, result }))
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ requestId: 'public-review', phase: 'queued' })
    expect(accept).toHaveBeenCalledWith('public-review', 1, result)
    await listener.close()
    await listener.close()
  })

  it('refuses GET, unknown paths, credential-like IDs, wrong types and different request identities', async () => {
    const options = await config()
    const accept = vi.fn(async () => view)
    const listener = new HumanHandoffListener(options, accept)
    close.push(() => listener.close())
    await listener.listen()
    expect((await post(options.humanHandoffSocketPath, '', '/human-requests/public-review/answers', 'GET')).status).toBe(404)
    expect((await post(options.humanHandoffSocketPath, '', '/different')).status).toBe(404)
    expect((await post(options.humanHandoffSocketPath, '', '/human-requests/bad.id/answers')).status).toBe(404)
    expect((await post(options.humanHandoffSocketPath, '{}', undefined, undefined, 'text/plain')).status).toBe(415)
    expect((await post(options.humanHandoffSocketPath, '{}', undefined, undefined, null)).status).toBe(415)
    expect((await post(options.humanHandoffSocketPath, '{}')).status).toBe(409)
    expect((await post(options.humanHandoffSocketPath, JSON.stringify({ requestRevision: 1, result: { ...result, requestId: 'another' } }))).status).toBe(409)
    expect(accept).not.toHaveBeenCalled()
  })

  it('keeps server rejection distinct from receipt and rejects a body over the byte allowance', async () => {
    const options = await config()
    const accept = vi.fn(async () => { throw new Error('source revision changed') })
    const listener = new HumanHandoffListener(options, accept)
    close.push(() => listener.close())
    await listener.listen()
    const rejected = await post(options.humanHandoffSocketPath, JSON.stringify({ requestRevision: 1, result }))
    expect(rejected.status).toBe(409)
    expect(rejected.body).toContain('source revision changed')
    const oversized = await post(options.humanHandoffSocketPath, 'x'.repeat(options.maxTextBytes + 1))
    expect(oversized.status).toBe(409)
    expect(oversized.body).toContain('byte allowance')
  })

  it('rejects a delayed callback after owner retirement instead of returning an unsupported receipt phase', async () => {
    const options = await config()
    const listener = new HumanHandoffListener(options, async () => ({ ...view, phase: 'retired' }))
    close.push(() => listener.close())
    await listener.listen()
    const response = await post(options.humanHandoffSocketPath, JSON.stringify({ requestRevision: 1, result }))
    expect(response.status).toBe(409)
    expect(response.body).toContain('retired')
  })

  it('preserves a live listener, regular file and symlink instead of replacing them', async () => {
    const options = await config()
    const first = new HumanHandoffListener(options, async () => view)
    const second = new HumanHandoffListener(options, async () => view)
    close.push(() => first.close(), () => second.close())
    await first.listen()
    const inode = (await lstat(options.humanHandoffSocketPath)).ino
    await expect(second.listen()).rejects.toThrow('Another Host')
    expect((await lstat(options.humanHandoffSocketPath)).ino).toBe(inode)
    await first.close()
    await writeFile(options.humanHandoffSocketPath, 'preserve')
    await expect(second.listen()).rejects.toThrow('unknown')
    expect(await readFile(options.humanHandoffSocketPath, 'utf8')).toBe('preserve')
    const linked = await config()
    await symlink(options.humanHandoffSocketPath, linked.humanHandoffSocketPath)
    const third = new HumanHandoffListener(linked, async () => view)
    close.push(() => third.close())
    await expect(third.listen()).rejects.toThrow('unknown')
  })

  it('requires a canonical absolute path and an owner-private directory', async () => {
    const options = await config()
    const relative = new HumanHandoffListener({ ...options, humanHandoffSocketPath: 'relative.sock' }, async () => view)
    await expect(relative.listen()).rejects.toThrow('absolute')
    await chmod(join(options.humanHandoffSocketPath, '..'), 0o755)
    const publicDirectory = new HumanHandoffListener(options, async () => view)
    await expect(publicDirectory.listen()).rejects.toThrow('private')
  })

  it('rejects an ownership probe that accepts a connection but never establishes a result', async () => {
    const options = await config()
    const stale = createServer()
    await new Promise<void>((resolve) => { stale.listen(options.humanHandoffSocketPath, resolve) })
    close.push(async () => {
      await new Promise<void>((resolve, reject) => { stale.close((error) => { if (error) reject(error); else resolve() }) })
    })
    const listener = new HumanHandoffListener(options, async () => view)
    await expect(listener.listen()).rejects.toThrow('Another Host')
  })
})
