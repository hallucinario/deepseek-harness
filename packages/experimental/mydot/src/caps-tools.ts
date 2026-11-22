/** Native MyDot capability admission and receipt-bound artifact presentation. */
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { appendPluginRecord, type SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Space } from './types.ts'
import { capsDigest, compileCapsBundle, type CapsInvocationBinding, type CapsScope } from './caps-mcp.ts'
import { capsHandoffDirectory, verifyCapsBundle } from './caps-artifacts.ts'

/** The registered native tool name recorded in Session call events. */
export const capsToolName = 'caps_compile_document_bundle'
const modelKeys = new Set(['name', 'title', 'documents', 'toc', 'checkLinks'])
const controlDirectories = new Set(['.git', 'node_modules', '.hcap', capsHandoffDirectory])

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Exact matched preflight and native call retained before sending a Caps invocation. */
    'plugin:mydot/caps-dispatch': Omit<CapsScope, 'workspace' | 'spaceId'> & CapsInvocationBinding & {
      callSequence: SessionSeq
      runtimeVersion: string
    }
    /** Caps outcome linked to one durable dispatch intent independently of the tool response. */
    'plugin:mydot/caps-settlement': { dispatchSequence: SessionSeq; observation: Record<string, string | boolean> }
  }
}

/** Operator-selected launcher and local workspace scope for the optional Caps tool. */
export interface CapsConfig {
  /** Canonical executable path managed outside the approved workspaces. */
  launcher: string
  /** Exact local Session roots allowed to invoke Caps. */
  workspaceRoots: string[]
  /** Maximum elapsed milliseconds for one check-and-invoke exchange. */
  timeoutMs: number
}

/** Loader validation for the optional Caps Host configuration. */
export const capsConfigSchema: z<CapsConfig> = z.object({
  launcher: z.string().required(),
  workspaceRoots: z.array(z.string()).required(),
  timeoutMs: z.number().min(1).max(2_147_483_647).step(1).required(),
})

const stringValue = { type: 'string' } as const
const requiredString = { ...stringValue, required: true } as const

function inTree(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith('..' + sep) && !isAbsolute(fromRoot))
}

function safeRelative(path: string): boolean {
  return !isAbsolute(path) && !/[:\\\0]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !controlDirectories.has(part))
}

/** Derive stable references from the exact Session and its durable turn start.
 * @param sessionId - Owning DSH Session.
 * @param turnStart - Original turn start sequence.
 * @returns Stable IDs shared by tool admission and observation readback.
 */
export function capsAttemptRefs(sessionId: SessionId, turnStart: number): Omit<CapsScope, 'workspace' | 'spaceId'> {
  const sessionRef = 'dsh-session-' + capsDigest(sessionId).slice(7)
  const turnRef = capsDigest(JSON.stringify([sessionRef, turnStart])).slice(7)
  return { sessionRef, taskRef: 'dsh-task-' + turnRef,
    executionRef: 'dsh-run-' + turnRef, requestId: 'dsh-caps-' + turnRef }
}

/** Mount the native tool on the MyDot Host and await its transports at disposal.
 * @param ctx - MyDot Host services and owning effect scope.
 * @param config - Host-owned launcher and enrolled workspace roots.
 * @param resolveSpace - MyDot's durable Session association, after storage initialization.
 * @param textLimit - MyDot's current-file reader byte limit.
 * @param lifecycle - MyDot storage and notification lifetime.
 */
export function mountCapsTool(
  ctx: Context, config: CapsConfig, resolveSpace: (session: SessionId) => Promise<Space | undefined>,
  textLimit: number, lifecycle: AbortSignal,
): void {
  if (!isAbsolute(config.launcher) || config.workspaceRoots.length === 0
    || !config.workspaceRoots.every(root => isAbsolute(root) && !inTree(root, config.launcher))
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647) {
    throw new Error('MyDot Caps requires an absolute external launcher, approved absolute workspaces and a valid timeout')
  }
  const closing = new AbortController()
  const running = new Set<Promise<unknown>>()
  const pending = new WeakMap<ToolExecution, { turn: number; paths: string[] }>()
  ctx.effect(() => async () => { closing.abort(); await Promise.allSettled(running) })
  ctx.tools.register(defineTool({
    name: capsToolName,
    description: 'Compile text documents from the current MyDot Space workspace using Caps. One attempt per turn. If its outcome is unknown, report the request ID and wait for confirmation before trying again.',
    parameters: {
      name: { ...requiredString, description: 'Lowercase bundle name' },
      title: { ...stringValue },
      toc: { type: 'boolean' },
      checkLinks: { type: 'boolean' },
      documents: {
        type: 'array', required: true,
        items: { type: 'object', additionalProperties: false, properties: {
          source: { ...requiredString, description: 'Existing path relative to the Space workspace' },
          title: stringValue,
          excerpt: stringValue,
        } },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: requiredString, reason: stringValue, requestId: requiredString, sessionRef: requiredString, taskRef: requiredString,
        executionRef: requiredString, runtimeVersion: stringValue, installedVersion: stringValue, invocationId: stringValue,
        executionFingerprint: stringValue,
        resultDigest: stringValue, receiptVerification: stringValue, recordingStatus: stringValue, usageEventId: stringValue,
        usageRecording: stringValue, duplicate: { type: 'boolean' },
        artifacts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: requiredString, digest: requiredString } } },
        handoff: requiredString,
      } },
      render: (_args, { runtimeVersion: _runtimeVersion, ...result }) => [{ type: 'text', text: JSON.stringify(result) }],
      presentationMeta: (_args, result) => result,
    },
    async execute(args, exec) {
      if (exec.agent === undefined || exec.parent !== undefined) throw new Error('Caps requires a native call from an open MyDot Session')
      if (Object.keys(args).some(key => !modelKeys.has(key)) || !/^[a-z][a-z0-9-]*$/u.test(args.name)
        || args.title === '' || args.documents.length === 0) throw new Error('Caps accepts valid bundle arguments only')
      const signal = AbortSignal.any([exec.signal, lifecycle, closing.signal])
      const session = exec.agent.session
      const boundary = ctx.get('sessionProjections')?.stateOf(session, 'turnBoundary')
      const startSeq = boundary?.openTurnStartSeq
      if (boundary === undefined || startSeq == null) throw new Error('Caps requires an open turn')
      const space = await resolveSpace(session.id)
      if (space === undefined || space.archived || session.header.cwd === undefined) throw new Error('Caps requires an active MyDot Space with an enrolled workspace')
      const workspace = await realpath(session.header.cwd)
      if (!config.workspaceRoots.includes(workspace) || inTree(workspace, await realpath(config.launcher))
        || ctx.sandboxPolicy.resolve({ session }).mode === 'read-only') throw new Error('Caps is unavailable for this Session workspace or policy')
      for (const { source } of args.documents) {
        if (!safeRelative(source) || !inTree(workspace, await realpath(join(workspace, source)))
          || !(await lstat(join(workspace, source))).isFile()) throw new Error('Caps documents must be regular files within the approved workspace')
      }
      if (!await ctx.sessions.flush(session)) throw new Error('Caps requires durable Session storage')
      using retained = await ctx.sessionQuery.observeSession(session.id)
      const calls = retained.events.filter(event => event.type === 'tool/call')
        .filter(event => event.seq > startSeq && event.data.name === capsToolName)
      const refs = capsAttemptRefs(session.id, startSeq)
      const scope = { workspace, spaceId: space.id, ...refs }
      if (calls.length !== 1 || calls[0]?.data.callId !== exec.callId) {
        return { ...refs, status: 'not_dispatched', handoff: 'not_applicable', reason: 'This turn already has a Caps call or its admission could not be confirmed' }
      }
      signal.throwIfAborted()
      const { getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot')
      const runtimeVersion = getDshRuntimeVersion()
      const callSequence = calls[0].seq
      const work = (async () => {
        let dispatchSequence: SessionSeq | undefined
        const outcome = await compileCapsBundle(config.launcher, scope, args, runtimeVersion, config.timeoutMs, signal, async (binding) => {
          dispatchSequence = appendPluginRecord(session, 'plugin:mydot/caps-dispatch', { callSequence, runtimeVersion, ...refs, ...binding })
          if (!await ctx.sessions.flush(session)) throw new Error('Caps requires a durable dispatch record')
        })
        const artifacts = await verifyCapsBundle(scope, args, outcome, textLimit, signal)
        const observation = {
          ...refs, runtimeVersion, status: outcome.status,
          handoff: outcome.status !== 'succeeded' ? 'not_applicable' : artifacts === undefined ? 'unavailable' : 'verified',
          ...outcome.invocationId === undefined ? {} : { invocationId: outcome.invocationId },
          ...outcome.executionFingerprint === undefined ? {} : { executionFingerprint: outcome.executionFingerprint },
          ...outcome.installedVersion === undefined ? {} : { installedVersion: outcome.installedVersion },
          ...outcome.resultDigest === undefined ? {} : { resultDigest: outcome.resultDigest },
          ...outcome.duplicate === undefined ? {} : { duplicate: outcome.duplicate },
          ...outcome.recordingStatus === undefined ? {} : { recordingStatus: outcome.recordingStatus },
          ...outcome.receipt === undefined ? {} : { receiptVerification: outcome.receipt.verification.status },
          ...outcome.observation?.eventId == null ? {} : { usageEventId: outcome.observation.eventId },
          usageRecording: outcome.observation?.status ?? 'unknown',
        }
        if (dispatchSequence !== undefined) {
          appendPluginRecord(session, 'plugin:mydot/caps-settlement', { dispatchSequence, observation })
          // This evidence survives even when ToolRegistry replaces the returned result with ABORTED.
          await ctx.sessions.flush(session)
        }
        if (artifacts !== undefined && !signal.aborted) {
          pending.set(exec, { turn: boundary.lastTurn, paths: artifacts.map(file => file.path) })
        }
        return {
          ...observation, ...outcome.reason === undefined ? {} : { reason: outcome.reason },
          ...artifacts === undefined ? {} : { artifacts },
        }
      })()
      running.add(work)
      return await work.finally(() => { running.delete(work) })
    },
  }))
  ctx.on('tools/result', (exec, result) => {
    const delivery = pending.get(exec)
    pending.delete(exec)
    if (delivery === undefined || result.isError || exec.signal.aborted || closing.signal.aborted) return
    exec.agent?.session.append('deliverables/presented', {
      turn: delivery.turn, callId: exec.callId, files: delivery.paths.map(path => ({ path, description: 'Caps documentation bundle' })),
    })
  })
}
