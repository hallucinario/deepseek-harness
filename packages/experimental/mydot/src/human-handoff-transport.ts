/** Owner-only Unix callback for server-generated survey result references. */
import { createServer, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { chmod, lstat, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { surveyResultSchema } from './human-handoff-state.ts'
import type { HumanRequestId, HumanRequestView, SurveyHandoffResult } from './types.ts'

/** Validated listener inputs; configuration resolution supplies the measured deadline. */
export interface HumanHandoffListenerConfig {
  /** Canonical absolute socket path in an owner-private directory. */
  humanHandoffSocketPath: string
  /** Finite callback deadline in milliseconds. */
  humanHandoffTimeoutMs: number
  /** Complete incoming body byte allowance. */
  maxTextBytes: number
}

/** Read one bounded JSON result over the handoff process boundary.
 * @param body - HTTP body chunks.
 * @param maxBytes - Existing MyDot UTF-8 payload allowance.
 * @returns Parsed JSON for the owning schema to validate.
 */
export async function readHandoffJson(body: AsyncIterable<Uint8Array | string>, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    const bytes = Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maxBytes) throw new Error('Human handoff payload exceeds the configured byte allowance')
    chunks.push(bytes)
  }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  return value
}

/** A finite local HTTP listener; filesystem ownership authenticates the local writer. */
export class HumanHandoffListener {
  private readonly server: Server
  private readonly active = new Set<Promise<void>>()

  constructor(private readonly config: HumanHandoffListenerConfig,
    accept: (requestId: HumanRequestId, revision: number, result: SurveyHandoffResult) => Promise<HumanRequestView>) {
    this.server = createServer((request, response) => {
      const operation = (async () => {
        const match = /^\/human-requests\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,119})\/answers$/.exec(request.url ?? '')
        if (request.method !== 'POST' || match?.[1] === undefined) { response.writeHead(404).end(); return }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') { response.writeHead(415).end(); return }
        const timer = setTimeout(() => { request.destroy(new Error('Human handoff request deadline exceeded')) }, config.humanHandoffTimeoutMs)
        try {
          const body = z.object({ requestRevision: z.number().int().positive(), result: surveyResultSchema }).strict()
            .parse(await readHandoffJson(request, config.maxTextBytes))
          if (body.result.requestId !== match[1]) throw new Error('Callback path and result request identities differ')
          const receipt = await accept(body.result.requestId, body.requestRevision, body.result)
          if (receipt.phase === 'retired') throw new Error('The human request was retired; this saved result will not resume it')
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            .end(JSON.stringify({ requestId: receipt.request.requestId, phase: receipt.phase }))
        } catch (error: unknown) {
          if (!response.headersSent) response.writeHead(409, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            .end(JSON.stringify({ error: 'handoff_not_accepted', message: String(error) }))
        } finally { clearTimeout(timer) }
      })().finally(() => { this.active.delete(operation) })
      this.active.add(operation)
    })
    this.server.requestTimeout = config.humanHandoffTimeoutMs
    this.server.headersTimeout = config.humanHandoffTimeoutMs
  }

  /** Bind only in an existing owner-private directory, preserving unknown paths.
   * @returns Ready once the socket has owner-only permissions.
   */
  async listen(): Promise<void> {
    const path = this.config.humanHandoffSocketPath
    const parentPath = dirname(path)
    if (!isAbsolute(path) || process.getuid === undefined || await realpath(parentPath) !== parentPath) throw new Error('Human handoff requires a canonical absolute POSIX socket path')
    const parent = await lstat(parentPath)
    if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw new Error('Human handoff socket directory must be private and owned by the Host user')
    const previous = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (previous !== undefined) {
      if (!previous.isSocket() || previous.uid !== parent.uid) throw new Error('Refusing to replace an unknown handoff socket path')
      await new Promise<void>((resolve, reject) => {
        const probe = createConnection(path)
        probe.setTimeout(this.config.humanHandoffTimeoutMs)
        probe.once('connect', () => { probe.destroy(); reject(new Error('Another Host owns the handoff socket')) })
        probe.once('timeout', () => { probe.destroy(); reject(new Error('Handoff socket ownership is unknown')) })
        probe.once('error', (error: Error) => {
          probe.destroy()
          if ('code' in error && error.code === 'ECONNREFUSED') resolve()
          else reject(error)
        })
      })
      const current = await lstat(path)
      if (current.ino !== previous.ino || current.dev !== previous.dev) throw new Error('Handoff socket changed during startup')
      await rename(path, `${path}.tobedeleted-${Date.now()}`)
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(path, () => { this.server.off('error', reject); resolve() })
    })
    try { await chmod(path, 0o600) }
    catch (error: unknown) { await this.close(); throw error }
  }

  /** Stop ingress and drain the finite callbacks owned by this plugin generation.
   * @returns Resolution after the listener and accepted requests have closed.
   */
  async close(): Promise<void> {
    if (this.server.listening) {
      const closed = new Promise<void>((resolve, reject) => this.server.close((error) => { if (error) reject(error); else resolve() }))
      this.server.closeAllConnections()
      await closed
    }
    await Promise.allSettled([...this.active])
  }
}
