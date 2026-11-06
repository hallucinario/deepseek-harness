/** Credential-isolated, bounded HTTP boundary to the separately running broker. */

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import http from 'node:http'
import { z } from 'zod'
import type { BrokerFailure, BrokerRequest, BrokerResponse, JsonValue, Operation } from '@deepseek-ai/dsh-experimental-mydot-integration-broker/types'
import type { ResolvedConfig } from './config.ts'
import { argumentSchemas } from './input.ts'

type UnixRequester = (options: http.RequestOptions, response: (value: http.IncomingMessage) => void) => http.ClientRequest

const operationSchema = z.enum(Object.keys(argumentSchemas) as [Operation, ...Operation[]])
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue),
]))
const responseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ version: z.literal(1), ok: z.literal(true), operation: operationSchema,
    connectionId: z.string().optional(), resourceId: z.string().optional(), requestId: z.string().optional(),
    accountLabel: z.string().optional(), data: jsonValue, nextCursor: z.string().optional(), warnings: z.array(z.string()) }),
  z.strictObject({ version: z.literal(1), ok: z.literal(false), error: z.strictObject({
    code: z.string().max(100), message: z.string().max(1000), outcome: z.enum(['not_started', 'unknown']), retryable: z.literal(false),
  }) }),
])

/**
 * Produce a safe failure without exposing paths, tokens or raw network errors.
 * @param code - Stable machine-readable reason.
 * @param message - Public remediation.
 * @param outcome - Whether submission may already have changed the provider.
 * @returns Protocol failure with automatic retries prohibited.
 */
export function failure(code: string, message: string, outcome: 'not_started' | 'unknown' = 'not_started'): BrokerFailure {
  return { version: 1, ok: false, error: { code, message, outcome, retryable: false } }
}

/**
 * Bound the complete model-visible text, including labels and result envelope.
 * @param response - Validated broker response or local failure.
 * @param maxBytes - Hard UTF-8 byte budget.
 * @returns JSON text, or a minimal marker when the caller supplies an unusably tiny budget.
 */
export function formatResult(response: BrokerResponse, maxBytes: number): string {
  const text = JSON.stringify({ contentTrust: 'external_untrusted_data', result: response })
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const omitted = JSON.stringify(response.ok
    ? { ok: true, operation: response.operation, contentOmitted: true, message: 'Operation completed. Result exceeded the output budget; use a narrower read. Do not repeat a mutation.' }
    : { ok: false, error: { code: response.error.code, outcome: response.error.outcome, retryable: false }, contentOmitted: true })
  if (Buffer.byteLength(omitted, 'utf8') <= maxBytes) return omitted
  if (maxBytes >= 2) return '{}'
  return maxBytes >= 1 ? '0' : ''
}

/** One plugin generation owns all in-flight transport work and its cancellation. */
export class BrokerClient {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<BrokerResponse>>()

  /**
   * @param config - Validated immutable Host settings.
   * @param unixRequester - External HTTP boundary; defaults to Node's socket-aware request implementation.
   */
  constructor(private readonly config: ResolvedConfig, private readonly unixRequester: UnixRequester = http.request) {}

  /**
   * Dispatch exactly once. Transport failures never trigger mutation retries.
   * @param request - Strict request with Host-bound Session and call identity.
   * @param signal - Owning tool-call cancellation.
   * @returns Validated result or safe denial/unknown outcome.
   */
  execute(request: BrokerRequest, signal: AbortSignal): Promise<BrokerResponse> {
    if (this.lifetime.signal.aborted || signal.aborted) return Promise.resolve(failure('cancelled', 'Request cancelled before submission.'))
    const promise = this.send(request, signal)
    this.pending.add(promise)
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise))
    return promise
  }

  /** Cancel and await all owned requests before a plugin generation can unload. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending])
  }

  private async send(request: BrokerRequest, callerSignal: AbortSignal): Promise<BrokerResponse> {
    const deadline = new AbortController()
    const timeout = setTimeout(() =>{  deadline.abort() }, this.config.requestTimeoutMs)
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal, deadline.signal])
    let submitted = false
    let token: string
    try {
      try { token = await readExecutorToken(this.config.executorTokenFile) }
      catch { return failure('executor_credential_unavailable', 'The Host executor credential is unavailable or not a private regular file. Ask the operator to check its configuration.') }
      if (signal.aborted) return failure('cancelled', 'Request cancelled before submission.')
      submitted = true
      const response = this.config.executorSocketPath === undefined
        ? await fetchBroker(this.config, request, token, signal)
        : await requestUnix(this.config.executorSocketPath, request, token, signal, this.config.maxResultBytes, this.unixRequester)
      const text = response.text
      if (text.includes(token)) return failure('invalid_broker_response', 'Broker returned an unsafe response. Check the broker audit before repeating a change.', 'unknown')
      const parsed = responseSchema.safeParse(JSON.parse(text))
      if (!parsed.success) return failure('invalid_broker_response', 'Broker returned an invalid response. Check the broker audit before repeating a change.', 'unknown')
      const result = parsed.data as BrokerResponse
      if (result.ok && (!response.ok || result.operation !== request.operation
        || result.connectionId !== request.connectionId || result.resourceId !== request.resourceId
        || (result.requestId !== undefined && result.requestId !== request.requestId))) {
        return failure('response_identity_mismatch', 'Broker response did not match the requested account and operation. Check the broker audit before repeating a change.', 'unknown')
      }
      return result
    } catch {
      return failure(signal.aborted ? 'request_cancelled' : 'broker_unavailable',
        submitted ? 'Broker response was not confirmed. A change may already have completed. Inspect the broker audit; do not automatically retry.' : 'Broker request could not start.',
        submitted ? 'unknown' : 'not_started')
    } finally { clearTimeout(timeout) }
  }
}

interface HttpResult {
  ok: boolean
  text: string
}

async function fetchBroker(config: ResolvedConfig, request: BrokerRequest, token: string, signal: AbortSignal): Promise<HttpResult> {
  const response = await fetch(`${config.brokerUrl}/v1/execute`, {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(request),
  })
  return { ok: response.ok, text: await readBounded(response, config.maxResultBytes) }
}

/** Connect only to the protected local socket; settlement waits for the owned HTTP request to close. */
async function requestUnix(
  socketPath: string, value: BrokerRequest, token: string, signal: AbortSignal, maxBytes: number, send: UnixRequester,
): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    let failure: Error | undefined
    let result: HttpResult | undefined
    const request = send({
      socketPath, path: '/v1/execute', method: 'POST', agent: false, signal, maxHeaderSize: 16_384,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > maxBytes) {
          failure = new Error('broker response too large')
          response.destroy(failure)
          request.destroy(failure)
          return
        }
        chunks.push(chunk)
      })
      response.once('error', (error) => { failure = error; request.destroy(error) })
      response.once('end', () => {
        if (response.complete && failure === undefined) {
          const status = response.statusCode ?? 0
          result = { ok: status >= 200 && status < 300, text: Buffer.concat(chunks, size).toString('utf8') }
        }
      })
    })
    request.once('error', (error) => { failure = error })
    request.once('close', () => {
      if (result !== undefined) resolve(result)
      else reject(failure ?? new Error('broker response incomplete'))
    })
    request.end(JSON.stringify(value))
  })
}

async function readExecutorToken(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 4096 || stat.size < 32) throw new Error('invalid credential file')
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (stat.uid !== 0 && stat.uid !== process.getuid?.()))) {
      throw new Error('credential file is not private')
    }
    const buffer = Buffer.alloc(4097)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const token = buffer.subarray(0, bytesRead).toString('utf8').trim()
    if (!/^[A-Za-z0-9_-]{32,4096}$/u.test(token)) throw new Error('invalid executor credential')
    return token
  } finally { await handle.close() }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) throw new Error('empty broker response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw new Error('broker response too large')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
