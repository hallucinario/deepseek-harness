/** Task-owned stdio connection and narrow projections of the Caps v1 wire documents. */
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { z } from 'zod'

const capability = { capabilityId: 'docs.bundle.compile', interfaceId: 'cli' } as const
const outputVersion = 'output.hcap.hallucinar.io/v1'
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u)
const authority = z.object({
  taskRef: z.string(),
  sessionRef: z.string(),
  executionRef: z.string(),
  authorityDigest: digest,
})
const checkDocument = z.object({
  ...bindingShape(),
  kind: z.literal('CapabilityCheckResult'),
  status: z.enum(['ready', 'needs_approval', 'blocked', 'unavailable', 'stale']),
  authority: authority.optional(),
  installedVersion: z.string().min(1).nullable(),
  executionFingerprint: digest.nullable(),
})
const invokeDocument = z.object({
  ...bindingShape(),
  kind: z.literal('CapabilityInvocationResult'),
  status: z.enum(['rejected', 'succeeded', 'failed', 'timed_out', 'cancelled', 'unknown']),
  requestId: z.string(),
  invocationId: z.string().min(1).nullable(),
  duplicate: z.boolean(),
  componentExitCode: z.number().int().nullable(),
  executionFingerprint: digest,
  resultDigest: digest.nullable(),
  result: z.unknown(),
  recordingStatus: z.enum(['ok', 'degraded']),
  receipt: z.unknown().optional(),
})
const receiptDocument = z.object({
  version: z.literal('receipt/2'),
  requestRef: digest,
  invocationRef: digest,
  executionFingerprint: digest,
  resultDigest: digest.nullable(),
  authority,
  outputValidation: z.enum(['passed', 'failed', 'not_run', 'unknown']),
  verification: z.object({ status: z.enum(['passed', 'failed', 'not_verified', 'unknown', 'error']) }),
  artifactObservations: z.array(z.object({
    reference: digest,
    observedDigest: digest.nullable(),
    status: z.enum(['observed', 'missing', 'changed', 'digest_mismatch', 'unavailable']),
  })).max(100),
})
const bundleResult = z.strictObject({
  bundle: z.string().min(1),
  documentCount: z.number().int().nonnegative(),
  output: z.literal('bundle'),
  warnings: z.array(z.string()),
})
const usageObservation = z.object({ status: z.enum(['ok', 'degraded', 'skipped']), eventId: z.uuid().nullable() })
const refusedCodes = new Set([
  'HCAP_APPROVAL_REQUIRED', 'HCAP_CONTEXT_MISMATCH', 'HCAP_INPUT_INVALID',
  'HCAP_POLICY_DENIED', 'HCAP_REQUEST_CONFLICT', 'HCAP_RUNTIME_STALE', 'HCAP_RUNTIME_UNAVAILABLE',
])

function bindingShape() {
  return {
    apiVersion: z.literal(outputVersion),
    capabilityId: z.literal(capability.capabilityId),
    interfaceId: z.literal(capability.interfaceId),
  }
}

/** Stable references minted from the persisted DSH Session and native turn. */
export interface CapsScope {
  workspace: string
  spaceId: string
  requestId: string
  taskRef: string
  executionRef: string
  sessionRef: string
}

/** Capability payload admitted by the model-facing tool. */
export interface BundleInput {
  name: string
  title?: string
  documents: { source: string; title?: string; excerpt?: string }[]
  toc?: boolean
  checkLinks?: boolean
}

/** Bounded result facts linked to the task and returned by the fixed host. */
export interface CapsOutcome {
  status: z.infer<typeof checkDocument>['status'] | z.infer<typeof invokeDocument>['status'] | 'not_dispatched'
  reason?: string
  installedVersion?: string
  invocationId?: string
  executionFingerprint?: string
  resultDigest?: string
  duplicate?: boolean
  recordingStatus?: 'ok' | 'degraded'
  observation?: z.infer<typeof usageObservation>
  receipt?: z.infer<typeof receiptDocument>
  bundle?: z.infer<typeof bundleResult>
}

/** Produce the Caps digest encoding for bytes and stable binding values.
 * @param value - Raw UTF-8 string or file bytes.
 * @returns Algorithm-tagged lowercase digest.
 */
export function capsDigest(value: string | Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(value).digest('hex')
}

function matchesScope(ref: z.infer<typeof authority>, scope: CapsScope): boolean {
  return ref.sessionRef === scope.sessionRef && ref.taskRef === scope.taskRef && ref.executionRef === scope.executionRef
}

function invocationResult(
  reply: CallToolResult, scope: CapsScope, check: { executionFingerprint: string; authorityDigest: string; installedVersion: string },
): CapsOutcome {
  const parsed = invokeDocument.safeParse(reply.structuredContent)
  if (!parsed.success) {
    const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(reply.structuredContent)
    if (reply.isError && error.success && refusedCodes.has(error.data.error.code)) {
      return { status: 'rejected', reason: error.data.error.code }
    }
    return { status: 'unknown', reason: 'Unrecognized Caps invocation response' }
  }
  const value = parsed.data
  if (value.requestId !== scope.requestId || value.executionFingerprint !== check.executionFingerprint
    || (value.status === 'succeeded' && (reply.isError || value.componentExitCode !== 0 || value.invocationId === null))
    || (value.invocationId === null && (value.status !== 'unknown' || !value.duplicate))) {
    return { status: 'unknown', reason: 'Caps invocation identity or status did not match' }
  }
  const receipt = receiptDocument.safeParse(value.receipt)
  if (value.receipt !== undefined && (!receipt.success || value.invocationId === null
    || !matchesScope(receipt.data.authority, scope) || receipt.data.authority.authorityDigest !== check.authorityDigest
    || receipt.data.requestRef !== capsDigest(scope.requestId) || receipt.data.invocationRef !== capsDigest(value.invocationId)
    || receipt.data.executionFingerprint !== check.executionFingerprint || receipt.data.resultDigest !== value.resultDigest)) {
    return { status: 'unknown', reason: 'Caps receipt did not match the task, invocation or outcome' }
  }
  const observation = usageObservation.safeParse(reply._meta?.['hcap.hallucinar.io/observation'])
  const bundle = bundleResult.safeParse(value.result)
  // HCC canonical JSON sorts the fixed result fields lexically.
  if (bundle.success && capsDigest(JSON.stringify({
    bundle: bundle.data.bundle, documentCount: bundle.data.documentCount, output: bundle.data.output, warnings: bundle.data.warnings,
  })) !== value.resultDigest) {
    return { status: 'unknown', reason: 'Caps bundle result did not match the result digest' }
  }
  return {
    status: value.status,
    installedVersion: check.installedVersion,
    ...value.invocationId === null ? {} : { invocationId: value.invocationId },
    ...value.resultDigest === null ? {} : { resultDigest: value.resultDigest },
    executionFingerprint: value.executionFingerprint,
    duplicate: value.duplicate,
    recordingStatus: value.recordingStatus,
    ...observation.success ? { observation: observation.data } : {},
    ...receipt.success ? { receipt: receipt.data } : {},
    ...bundle.success ? { bundle: bundle.data } : {},
  }
}

/** Check and invoke under a single task-specific grant. A transport loss after invoke leaves an unknown outcome.
 * @param launcher - Exact, operator-managed executable outside the model's workspace.
 * @param scope - Selected workspace and derived task references.
 * @param input - Document bundle request.
 * @param timeoutMs - Operator-selected lifetime for the whole exchange.
 * @param caller - Tool and plugin cancellation.
 * @returns Validated invocation or a visible refusal/unknown outcome.
 */
export async function compileCapsBundle(
  launcher: string, scope: CapsScope, input: BundleInput, timeoutMs: number, caller: AbortSignal,
): Promise<CapsOutcome> {
  let submitted = false
  let client: Client | undefined
  const signal = AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
  try {
    const entry = await lstat(launcher)
    if (!entry.isFile() || (entry.mode & 0o022) !== 0 || (entry.uid !== 0 && entry.uid !== process.getuid?.())
      || await realpath(launcher) !== launcher) {
      return { status: 'not_dispatched', reason: 'Caps launcher must be a canonical operator-managed executable' }
    }
    const { getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')
    const version = getDshRuntimeVersion()
    signal.throwIfAborted()
    client = new Client({ name: 'MyDot Caps', version })
    await client.connect(new StdioClientTransport({
      command: launcher, cwd: dirname(launcher), stderr: 'ignore',
      args: ['--dsh-version', version, '--workspace', scope.workspace, '--space-id', scope.spaceId,
        '--session-ref', scope.sessionRef, '--task-ref', scope.taskRef, '--execution-ref', scope.executionRef, '--request-id', scope.requestId],
    }), { signal })
    const reply = await client.callTool({ name: 'check', arguments: { ...capability, input } }, { signal })
    const parsed = checkDocument.safeParse(reply.structuredContent)
    if (!parsed.success) return { status: 'not_dispatched', reason: 'Caps preflight response could not be read' }
    const check = parsed.data
    if (check.status !== 'ready') return { status: check.status, reason: 'Caps preflight did not authorize execution' }
    if (reply.isError || check.executionFingerprint === null || check.installedVersion === null
      || check.authority === undefined || !matchesScope(check.authority, scope)) {
      return { status: 'not_dispatched', reason: 'Caps preflight did not identify the requested task and installed capability' }
    }
    signal.throwIfAborted()
    submitted = true
    const result = await client.callTool({
      name: 'invoke', arguments: { ...capability, input, expectedFingerprint: check.executionFingerprint, requestId: scope.requestId },
    }, { signal })
    return invocationResult(result, scope, {
      executionFingerprint: check.executionFingerprint,
      authorityDigest: check.authority.authorityDigest,
      installedVersion: check.installedVersion,
    })
  } catch {
    return submitted
      ? { status: 'unknown', reason: 'Caps response was lost after dispatch' }
      : { status: 'not_dispatched', reason: 'Caps launcher or preflight is unavailable' }
  } finally {
    await client?.close()
  }
}
