/** Project one operator-selected, durably recorded turn for Foundry's Host intake. */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SESSION_QUERY_READ_WINDOW_MAX } from '@deepseek-ai/dsh-session-query'
import { z } from 'zod'
import type { SpaceId } from './types.ts'
import { capsAttemptRefs, capsToolName } from './caps-tools.ts'
import { readVerifiedArtifact } from './caps-artifacts.ts'

const artifactTypes = ['MARKDOWN_DOCUMENT', 'JSON'] as const
const digest = z.string().regex(/^[0-9a-f]{64}$/u)
const reference = z.string().refine(value => value.trim().length > 0)
const artifactIdentity = z.object({ sourceRef: reference, version: reference, artifactType: z.enum(artifactTypes) })
const artifactApproval = artifactIdentity.extend({ path: reference, contentDigest: digest })
const capsDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/u)
const scope = z.object({ taskRef: reference, sessionRef: reference, executionRef: reference })
const capsRecord = scope.extend({
  requestId: reference,
  status: z.enum(['not_dispatched', 'needs_approval', 'blocked', 'unavailable', 'stale', 'rejected',
    'succeeded', 'failed', 'timed_out', 'cancelled', 'unknown']),
  handoff: z.enum(['not_applicable', 'verified', 'unavailable']),
  runtimeVersion: reference.optional(),
  installedVersion: reference.optional(),
  invocationId: reference.optional(),
  executionFingerprint: capsDigest.optional(),
  resultDigest: capsDigest.optional(),
  receiptVerification: z.enum(['passed', 'failed', 'not_verified', 'unknown', 'error']).optional(),
  recordingStatus: z.enum(['ok', 'degraded']).optional(),
  usageEventId: z.uuid().optional(),
  usageRecording: z.enum(['ok', 'degraded', 'skipped', 'unknown']).optional(),
  duplicate: z.boolean().optional(),
  artifacts: z.array(z.object({ path: reference, digest: capsDigest })).optional(),
})

/** Exact root Session and independent disclosure selections from trusted Host code. */
export interface FoundryObservationSelection {
  projectId: string
  spaceId: SpaceId
  sessionId: SessionId
  firstSequence: number
  lastSequence: number
  requestSequence: number
  artifacts: readonly z.infer<typeof artifactApproval>[]
}

type ObservationStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN'
interface ObservationEvent {
  sequence: number
  type: 'RUN_STATE_TRANSITION' | 'MODEL_CALL_END' | 'TOOL_CALL_START' | 'TOOL_CALL_END' | 'TOOL_ERROR'
  payload: Record<string, string | number | boolean>
}
type ObservationArtifact = z.infer<typeof artifactIdentity> & { content: Uint8Array }

/** Foundry native intake payload and separately derived Caps binding for this attempt. */
export interface FoundryObservationProjection {
  hccScope: z.infer<typeof scope> | null
  observation: {
    identity: { projectId: string; requestId: string; sessionId: string; attemptId: string }
    runtimeVersion: string | null
    status: ObservationStatus
    observedAt: string
    eventRange: { firstSequence: number; lastSequence: number }
    events: ObservationEvent[]
    context: null
    artifacts: ObservationArtifact[]
  }
}

type ToolCall = Extract<SessionEvent, { type: 'tool/call' }>
type ToolResult = Extract<SessionEvent, { type: 'tool/result' }>
type CapsRecord = z.infer<typeof capsRecord>

const terminalTurnStatus = new Map<TurnEndReason['kind'], ObservationStatus>([
  ['aborted', 'CANCELLED'], ['error', 'FAILED'], ['blocked', 'FAILED'], ['max-tokens', 'FAILED'],
])
const terminalCapsStatus: Partial<Record<CapsRecord['status'], ObservationStatus>> = {
  succeeded: 'SUCCEEDED', cancelled: 'CANCELLED', failed: 'FAILED', timed_out: 'FAILED', rejected: 'FAILED', blocked: 'FAILED',
}

function attemptStatus(reason: TurnEndReason, hasCapsCall: boolean, caps?: CapsRecord): ObservationStatus {
  if (reason.kind !== 'completed') return terminalTurnStatus.get(reason.kind) ?? 'UNKNOWN'
  return hasCapsCall ? terminalCapsStatus[caps?.status ?? 'unknown'] ?? 'UNKNOWN' : 'SUCCEEDED'
}

const usageKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

function modelSettlement(event: Extract<SessionEvent, { type: 'assistant/message' }>): ObservationEvent {
  const { message: { source }, usage, interrupted } = event.data
  const payload: ObservationEvent['payload'] = { providerId: source.provider, modelId: source.model, interrupted: interrupted === true }
  for (const key of usageKeys) {
    const value = usage?.[key]
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0) payload[key] = value
  }
  return { sequence: event.seq, type: 'MODEL_CALL_END', payload }
}

async function readArtifacts(
  approvals: readonly z.infer<typeof artifactApproval>[], cwd: string | undefined, events: readonly SessionEvent[],
  turn: number, capsCall: ToolCall | undefined, caps: CapsRecord | undefined, limit: number, signal: AbortSignal,
): Promise<ObservationArtifact[]> {
  const artifacts: ObservationArtifact[] = []
  const identities = new Set<string>()
  let remaining = limit
  for (const { path, sourceRef, version, artifactType, contentDigest } of approvals) {
    signal.throwIfAborted()
    const identity = JSON.stringify([sourceRef, version])
    if (identities.has(identity)) throw new Error('Duplicate artifact version approval')
    identities.add(identity)
    if (cwd === undefined || !isAbsolute(cwd)) throw new Error('Artifact requires a recorded local workspace')
    const inWorkspace = relative(cwd, resolve(cwd, path))
    if (inWorkspace === '' || inWorkspace === '..' || inWorkspace.startsWith('..' + sep) || isAbsolute(inWorkspace)) {
      throw new Error('Approved artifact must be inside the recorded workspace')
    }
    const delivery = events.find(event => event.type === 'deliverables/presented' && event.data.turn === turn
      && (capsCall === undefined || (event.seq > capsCall.seq && event.data.callId === capsCall.data.callId))
      && event.data.files.some(file => file.path === path))
    if (delivery === undefined) throw new Error('Approved artifact was not presented by this attempt')
    const taggedDigest = 'sha256:' + contentDigest
    if (capsCall !== undefined && (caps?.handoff !== 'verified'
      || !caps.artifacts?.some(item => item.path === path && item.digest === taggedDigest))) {
      throw new Error('Approved Caps artifact did not match the recorded handoff')
    }
    const { bytes } = await readVerifiedArtifact(cwd, inWorkspace, taggedDigest, remaining, signal)
    remaining -= bytes.length
    artifacts.push({ sourceRef, version, artifactType, content: Uint8Array.from(bytes) })
  }
  return artifacts
}

/** Read an exact persisted root turn without activating or replaying its Session.
 * @param ctx - Existing Session registry and durable persistence.
 * @param selection - Host-approved project, root Session, bounds and files.
 * @param maxArtifactBytes - MyDot's configured text byte limit for the whole projection.
 * @param signal - Host and caller lifetime.
 * @returns Foundry's selected input and independently verifiable Caps binding.
 */
export async function projectFoundryObservation(
  ctx: Context, selection: FoundryObservationSelection, maxArtifactBytes: number, signal: AbortSignal,
): Promise<FoundryObservationProjection> {
  const { projectId, sessionId, firstSequence, lastSequence, requestSequence } = selection
  const length = lastSequence - firstSequence + 1
  if (!reference.safeParse(projectId).success
    || ![firstSequence, lastSequence, requestSequence].every(Number.isSafeInteger)
    || firstSequence < 0 || length < 3 || length > SESSION_QUERY_READ_WINDOW_MAX
    || requestSequence <= firstSequence || requestSequence >= lastSequence
    || selection.artifacts.length > SESSION_QUERY_READ_WINDOW_MAX) throw new Error('Invalid Foundry observation selection')
  signal.throwIfAborted()
  const approvals = selection.artifacts.map(approval => artifactApproval.parse(approval))
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('Foundry observation requires durable Session storage')
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) await ctx.sessions.flush(live)
  await using handle = await persistence.open(sessionId, 'read', { signal })
  if (handle.header.parentSession !== undefined || handle.header.origin === 'subagent' || handle.header.isSeeded) {
    throw new Error('Foundry observation requires a root Session')
  }
  const { events } = await handle.read(firstSequence, length, { signal })
  const first = events[0]
  const last = events.at(-1)
  if (events.length !== length || !events.every((event, offset) => event.seq === firstSequence + offset)
    || first?.type !== 'turn/start' || last?.type !== 'turn/end' || first.data.turn !== last.data.turn
    || events.slice(1, -1).some(event => event.type === 'turn/start' || event.type === 'turn/end')) {
    throw new Error('Foundry observation requires exactly one durable closed turn')
  }
  const requests = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
  const request = requests[0]
  if (requests.length !== 1 || request?.seq !== requestSequence || request.type !== 'user/message' || request.data.source.kind !== 'user') {
    throw new Error('Selected request is not the single recorded input for this turn')
  }
  const { source, id: messageId } = request.data
  const requestId = 'rpcId' in source ? source.rpcId : messageId
  const refs = capsAttemptRefs(sessionId, firstSequence)
  const turn = first.data.turn
  const capsCall = events.find((event): event is ToolCall =>
    event.type === 'tool/call' && event.data.turn === turn && event.data.name === capsToolName)
  const settled = capsCall === undefined ? undefined : events.find((event): event is ToolResult => event.type === 'tool/result'
    && event.data.turn === capsCall.data.turn && event.data.step === capsCall.data.step
    && event.data.message.toolCallId === capsCall.data.callId && event.sourceEventSeqs?.length === 1
    && event.sourceEventSeqs[0] === capsCall.seq)
  const parsed = capsRecord.safeParse(settled?.data.meta)
  const caps = parsed.success && matchesAttempt(parsed.data, refs)
    && (parsed.data.status !== 'succeeded' || (!settled?.data.message.isError && parsed.data.executionFingerprint !== undefined
      && parsed.data.invocationId !== undefined))
    ? parsed.data : undefined
  const status = attemptStatus(last.data.reason, capsCall !== undefined, caps)
  const artifacts = await readArtifacts(approvals, handle.header.cwd, events, turn, capsCall, caps, maxArtifactBytes, signal)
  const projected: ObservationEvent[] = []
  for (const event of events) {
    const sequence = event.seq
    if (event === first) projected.push({ sequence, type: 'RUN_STATE_TRANSITION', payload: { state: 'RUNNING' } })
    if (event === last) projected.push({ sequence, type: 'RUN_STATE_TRANSITION', payload: { state: status, reason: last.data.reason.kind } })
    if (event.type === 'assistant/message' && event.data.turn === turn) projected.push(modelSettlement(event))
    if (event === capsCall) {
      projected.push({ sequence, type: 'TOOL_CALL_START', payload: { toolName: capsToolName } })
    }
    if (event === settled) {
      const payload = caps === undefined ? { status: 'unverified' } : Object.fromEntries(
        Object.entries(caps).filter((item): item is [string, string | boolean] =>
          typeof item[1] === 'string' || typeof item[1] === 'boolean'),
      )
      projected.push({ sequence, type: settled.data.message.isError ? 'TOOL_ERROR' : 'TOOL_CALL_END', payload })
    }
  }
  signal.throwIfAborted()
  return {
    hccScope: caps === undefined ? null : scope.parse(caps),
    observation: {
      identity: { projectId, requestId, sessionId, attemptId: refs.executionRef },
      runtimeVersion: caps?.runtimeVersion ?? null, status, observedAt: new Date(last.time).toISOString(),
      eventRange: { firstSequence, lastSequence }, events: projected, context: null, artifacts,
    },
  }
}

function matchesAttempt(record: CapsRecord, refs: ReturnType<typeof capsAttemptRefs>): boolean {
  return record.requestId === refs.requestId && record.sessionRef === refs.sessionRef
    && record.taskRef === refs.taskRef && record.executionRef === refs.executionRef
}
