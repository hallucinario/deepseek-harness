/** Real fixed Unix-socket recorder provider; no model attestation is accepted. */
import { createServer } from 'node:net'
import * as net from 'node:net'
import { chmod, mkdtemp, realpath, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { TestContext } from 'vitest'
import { readRecorderStatus } from '../src/filing-recorder.ts'
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  return { ...actual, connect: vi.fn(actual.connect) }
})
const unix = it.skipIf(process.platform === 'win32')
unix('reads only the fixed private socket and strictly decodes recorder fields', async ({ onTestFinished }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mydot-rec-'))); await chmod(root, 0o700)
  const socketPath = join(root, 'rec.sock'); let request: unknown
  const server = createServer((socket) => { socket.once('data', (data) => {
    request = JSON.parse(data.toString())
    socket.end(JSON.stringify({ ok: true, result: { version: 'high-impact-recorder/v1', caseId: 'c'.repeat(32), planDigest: 'a'.repeat(64),
      state: 'recording', evidence: 'complete', readyForConfirmation: true, sequence: 1, observedAt: 1000,
      archiveRef: 'c'.repeat(32) + '/00000001.json',
      segments: [{ ref: 'c'.repeat(32) + '/00000001.json', start: 0, end: 1, round: 1, startedAt: 1000, monotonicNs: '12345', sha256: 'a'.repeat(64) }],
      protectedIntervals: [], gaps: [], operationLogs: [], operatorDigest: 'd'.repeat(64), queryRequired: false,
      deadline: '2099-01-01T00:00:00Z', receipt: { outcome: 'not_submitted' } } }) + '\n')
  }) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  onTestFinished(async () => { await new Promise<void>(resolve => server.close(() =>{  resolve() })); await rename(root, root + '.tobedeleted') })
  const result = await readRecorderStatus({ socketPath, timeoutMs: 1000, maxBytes: 4096 }, 'c'.repeat(32), 'a'.repeat(64))
  expect(result.readyForConfirmation).toBe(true)
  expect(request).toEqual({ command: 'status', caseId: 'c'.repeat(32), planDigest: 'a'.repeat(64) })
  await chmod(root, 0o755)
  await expect(readRecorderStatus({ socketPath, timeoutMs: 1000, maxBytes: 4096 }, 'c'.repeat(32), 'a'.repeat(64))).rejects.toThrow(/private/)
})

function status() {
  const caseId = 'c'.repeat(32)
  return { version: 'high-impact-recorder/v1', caseId, planDigest: 'a'.repeat(64), state: 'recording', evidence: 'complete',
    readyForConfirmation: true, sequence: 2, observedAt: 1000, archiveRef: caseId + '/00000002.json',
    segments: [{ ref: caseId + '/00000001.json', start: 0, end: 1, round: 1, startedAt: 1000, monotonicNs: '12345', sha256: 'a'.repeat(64) }],
    protectedIntervals: [{ ref: 'd'.repeat(32), start: 1, end: 2 }], gaps: [{ start: 2, reason: 'capture_failed' }], operationLogs: [],
    operatorDigest: 'd'.repeat(64), queryRequired: false, deadline: '2099-01-01T00:00:00Z', receipt: { outcome: 'not_submitted' } }
}
async function endpoint(cleanup: TestContext['onTestFinished'], reply: (socket: net.Socket) => void) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mydot-rec-errors-'))); await chmod(root, 0o700)
  const socketPath = join(root, 'rec.sock'); const clients = new Set<net.Socket>()
  const server = createServer((socket) => { clients.add(socket); socket.once('close', () => clients.delete(socket)); socket.once('data', () =>{  reply(socket) }) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  cleanup(async () => { for (const socket of clients) socket.destroy(); await new Promise<void>(resolve => server.close(() =>{  resolve() })); await rename(root, root + '.tobedeleted') })
  return { root, socketPath, timeoutMs: 1000, maxBytes: 4096 }
}
unix('rejects relative paths, ordinary files and absent platform owner identity before sending a request', async ({ onTestFinished }) => {
  await expect(readRecorderStatus({ socketPath: './rec.sock', timeoutMs: 1000, maxBytes: 4096 }, 'c'.repeat(32), 'a'.repeat(64))).rejects.toThrow(/canonical/)
  const config = await endpoint(onTestFinished, () => undefined)
  const filePath = join(config.root, 'ordinary'); await writeFile(filePath, 'not a socket')
  await expect(readRecorderStatus({ ...config, socketPath: filePath }, 'c'.repeat(32), 'a'.repeat(64))).rejects.toThrow(/owner socket/)
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid')!
  Reflect.deleteProperty(process, 'getuid')
  try { await expect(readRecorderStatus(config, 'c'.repeat(32), 'a'.repeat(64))).rejects.toThrow(/owner-private/) }
  finally { Object.defineProperty(process, 'getuid', descriptor) }
})
unix('projects archived segment, protection and gap references even without a trailing line break', async ({ onTestFinished }) => {
  const config = await endpoint(onTestFinished, socket => socket.end(JSON.stringify({ ok: true, result: status() })))
  const result = await readRecorderStatus(config, 'c'.repeat(32), 'a'.repeat(64))
  expect(result.segments).toEqual(['c'.repeat(32) + ':00000001.json'])
  expect(result.protectedIntervals).toEqual(['d'.repeat(32)])
  expect(result.gaps).toEqual(['gap-0-2-capture_failed'])
})
unix.each(['not JSON', '{}', JSON.stringify({ ok: true, result: { ...status(), password: 'redacted-fixture' } })])('reports malformed recorder responses without echoing their contents (%#)', async (body) => {
  const config = await endpoint(onTestFinished, socket => socket.end(body + '\n'))
  await expect(readRecorderStatus(config, 'c'.repeat(32), 'a'.repeat(64))).rejects.toThrow('Recorder returned invalid status fields')
})
unix('bounds a silent recorder and an oversized response', async ({ onTestFinished }) => {
  const silent = await endpoint(onTestFinished, () => undefined)
  await expect(readRecorderStatus({ ...silent, timeoutMs: 10 }, 'c'.repeat(32), 'a'.repeat(64))).rejects.toThrow(/deadline/)
  const large = await endpoint(onTestFinished, socket => socket.end(JSON.stringify({ ok: true, result: status() }) + '\n'))
  await expect(readRecorderStatus({ ...large, maxBytes: 8 }, 'c'.repeat(32), 'a'.repeat(64))).rejects.toThrow(/byte allowance/)
})
unix('settles a socket failure once when error and end notifications race', async ({ onTestFinished }) => {
  const config = await endpoint(onTestFinished, () => undefined)
  const socket = new net.Socket()
  const destroy = vi.spyOn(socket, 'destroy').mockReturnValue(socket)
  vi.spyOn(socket, 'write').mockReturnValue(true)
  vi.mocked(net.connect).mockReturnValueOnce(socket)
  const result = readRecorderStatus(config, 'c'.repeat(32), 'a'.repeat(64))
  await vi.waitFor(() =>{  expect(socket.listenerCount('error')).toBe(1) })
  socket.emit('connect'); socket.emit('data', Buffer.from('{')); socket.emit('error', new Error('private fixture detail')); socket.emit('end')
  await expect(result).rejects.toThrow('Recorder socket unavailable')
  expect(destroy).toHaveBeenCalledTimes(1)
})
