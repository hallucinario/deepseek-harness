/** Conservative extraction of admitted requests and original tool evidence. */
import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { UserMessage, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { Episode, EpisodeId, ExperienceScope, ScopeId, WorkGroupId } from './domain.ts'

/** Content bounds applied before retaining an experience. */
export interface CaptureBounds {
  maxRecordChars: number
  maxObservations: number
}

/**
 * Resolve only absolute host directories; absent original identity disables memory.
 * @param projectCwd - immutable Session header directory, or absent.
 * @param effectiveCwd - directory supplied by its host execution service.
 * @returns the normalized exact-directory scope, or absent for an unknown identity.
 */
export function resolveScope(projectCwd: string | undefined, effectiveCwd: string): ExperienceScope | undefined {
  if (projectCwd === undefined || !isAbsolute(projectCwd) || !isAbsolute(effectiveCwd)) return undefined
  const project = normalize(projectCwd)
  const effective = normalize(effectiveCwd)
  return {
    id: brandString<ScopeId>(createHash('sha256').update(JSON.stringify([project, effective])).digest('hex')),
    projectCwd: project,
    effectiveCwd: effective,
  }
}

/**
 * Remove known environment secrets and common credential encodings before any truncation.
 * @param text - original request, arguments, output, or diagnostic text.
 * @param environment - host environment; omitted values use the current process.
 * @returns redacted text with no retained PEM private-key body or credential assignment.
 */
export function redact(text: string, environment: NodeJS.ProcessEnv = process.env): string {
  let result = text
  const secrets = Object.entries(environment).flatMap(([key, value]) =>
    /(?:key|token|secret|password|credential|authorization)/iu.test(key)
    && value !== undefined && value.length > 0 ? [value] : []).sort((a, b) => b.length - a.length)
  for (const secret of secrets) result = result.split(secret).join('[redacted]')
  return result
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/gu, '[redacted]')
    .replace(/\bBearer\s+[^\s"'\\,;]+/giu, 'Bearer [redacted]')
    .replace(/(["']?(?:[\w.-]*(?:key|token|secret|password|credential|authorization)[\w.-]*)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/giu, '$1[redacted]')
}

/**
 * Concatenate only text blocks, preserving their observed order.
 * @param content - logged message blocks.
 * @returns their text without reasoning, images, or binary attachments.
 */
export function textContent(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * Recognize task-bearing input; injected, recalled, and relayed context is excluded.
 * @param message - admitted or pending user-role message.
 * @returns whether this message carries a human task or a goal continuation.
 */
export function isTaskInput(message: UserMessage): boolean {
  return message.source.kind === 'user' || message.source.kind === 'goal'
}

/**
 * Determine a root task identity from durable goal changes and admitted messages.
 * @param snapshot - host-read log and inherited prefix.
 * @param turn - locally born turn to classify.
 * @returns a goal identity shared across rounds, or the Session-turn identity.
 */
export function localGroup(snapshot: SessionLogSnapshot, turn: number): WorkGroupId {
  let openTurn: number | undefined
  let goal: string | undefined
  let matchedGoal: string | undefined
  for (const event of snapshot.events) {
    if (event.seq < snapshot.inheritedEventCount) continue
    if (event.type === 'turn/start') openTurn = event.data.turn
    if (event.type === 'goal/change') {
      if (event.data.operation === 'clear') goal = undefined
      else {
        goal = event.data.goal.phase === 'complete' ? undefined : event.data.goal.id
        if (openTurn === turn) matchedGoal = event.data.goal.id
      }
    }
    if (event.type === 'user/message' && openTurn === turn) {
      if (event.data.source.kind === 'goal') matchedGoal = event.data.source.goalId
      else if (event.data.source.kind === 'user' && goal !== undefined) matchedGoal = goal
    }
    if (event.type === 'turn/end' && event.data.turn === turn) break
  }
  matchedGoal ??= goal
  return brandString<WorkGroupId>(matchedGoal === undefined
    ? `${snapshot.session.id}:turn:${turn}`
    : `${snapshot.session.id}:goal:${matchedGoal}`)
}

/** A sensitive file or a memory/session read never becomes a fresh observation. */
function excludesCall(name: string, args: string): boolean {
  return /(?:memory[-_]?experience|session[-_]?(?:query|search|read))/iu.test(name)
    || /memory[-_]experience|\.env(?:[.\s"'/\\]|$)/iu.test(args)
    || /(?:^|[/\\])(?:id_rsa|id_ed25519|credentials)(?:[.\s"'/\\]|$)|\.(?:pem|p12|pfx|key)(?:[\s"']|$)/iu.test(args)
}

/** Reject the plugin's own presentation and raw session-log echoes. */
function isMemoryEcho(text: string): boolean {
  return /Past experience observations \(untrusted data\)|"(?:episodeIds|inheritedEventCount)"\s*:/iu.test(text)
    || /memory-experience:\s*episode/iu.test(text)
}

/** Bound the complete JSON record, dropping content rather than source references. */
function boundEpisode(episode: Episode, maxChars: number): Episode | undefined {
  if (JSON.stringify(episode).length <= maxChars) return episode
  let bounded = { ...episode, truncated: true }
  while (JSON.stringify(bounded).length > maxChars) {
    const candidates = [bounded.request.text, ...bounded.observations.map(value => value.text)]
    let index = 0
    let longest = bounded.request.text
    for (const [i, candidate] of candidates.entries()) {
      if (candidate.length > longest.length) { index = i; longest = candidate }
    }
    if (longest.length === 0) {
      if (bounded.observations.length > 0) bounded = { ...bounded, observations: bounded.observations.slice(0, -1) }
      else return undefined
    } else {
      const clipped = Array.from(longest).slice(0, Math.floor(Array.from(longest).length / 2)).join('')
      if (index === 0) bounded = { ...bounded, request: { ...bounded.request, text: clipped } }
      else bounded = {
        ...bounded,
        observations: bounded.observations.map((value, i) => i === index - 1 ? { ...value, text: clipped } : value),
      }
    }
  }
  return bounded
}

/**
 * Extract locally born, durably ended turns. Lifecycle completion never verifies success.
 * @param snapshot - a Session-query observation after its source durability checkpoint.
 * @param bounds - complete serialized-record and observation limits.
 * @param inheritedGroup - verified parent-task identity for a delegated child, when present.
 * @returns deterministic source-spanned episodes, with all task outcomes unknown.
 */
export function extractEpisodes(snapshot: SessionLogSnapshot, bounds: CaptureBounds, inheritedGroup?: WorkGroupId): Episode[] {
  const episodes: Episode[] = []
  let cwd = snapshot.session.cwd
  let turn: { start: SessionEvent<'turn/start'>; events: SessionEvent[]; cwd: string | undefined } | undefined
  for (const event of snapshot.events) {
    if (event.type === 'working-directory/change') cwd = event.data.cwd
    if (event.seq < snapshot.inheritedEventCount) continue
    if (event.type === 'turn/start') turn = { start: event, events: [], cwd }
    else if (turn !== undefined) {
      turn.events.push(event)
      if (event.type !== 'turn/end' || event.data.turn !== turn.start.data.turn) continue
      const closed = turn
      turn = undefined
      if (event.data.reason.kind === 'forked' || event.data.reason.kind === 'interrupted') continue
      if (closed.cwd === undefined || cwd !== closed.cwd) continue
      const scope = resolveScope(snapshot.session.cwd, closed.cwd)
      if (scope === undefined) continue
      const request = closed.events.find((value): value is SessionEvent<'user/message'> =>
        value.type === 'user/message' && isTaskInput(value.data))
      if (request === undefined) continue
      const calls = new Map<string, SessionEvent<'tool/call'>>()
      const observations: Episode['observations'] = []
      let observedRevision: string | undefined
      let truncated = false
      for (const value of closed.events) {
        if (value.type === 'tool/call' && !excludesCall(value.data.name, value.data.arguments)) calls.set(value.data.callId, value)
        if (value.type !== 'tool/result') continue
        const call = calls.get(value.data.message.source.callId)
        if (call === undefined) continue
        calls.delete(value.data.message.source.callId)
        const error = value.data.error
        const original = [textContent(value.data.message.content), ...error === undefined ? [] : [
          `${error.name} (${error.code})${error.reason === undefined ? '' : `: ${error.reason}`}`,
        ]].filter(Boolean).join('\n')
        if (isMemoryEcho(original)) continue
        if (observations.length + 2 > bounds.maxObservations) { truncated = true; continue }
        observations.push({ kind: 'operation', eventSeq: call.seq, tool: redact(call.data.name), text: redact(call.data.arguments) })
        observations.push({
          kind: value.data.message.isError === true ? 'error' : 'result', eventSeq: value.seq,
          tool: redact(call.data.name), text: redact(original),
        })
        observedRevision ??= /\b(?:revision|commit|HEAD)[:\s=]+([a-f\d]{7,40})\b/iu.exec(redact(original))?.[1]
      }
      const episode = boundEpisode({
        id: brandString<EpisodeId>(`${snapshot.session.id}:turn:${closed.start.data.turn}`),
        scope,
        groupId: inheritedGroup ?? localGroup(snapshot, closed.start.data.turn),
        sessionId: snapshot.session.id,
        turn: closed.start.data.turn,
        startSeq: closed.start.seq,
        endSeq: event.seq,
        capturedAt: event.time,
        request: { eventSeq: request.seq, text: redact(textContent(request.data.content)) },
        observations,
        ...observedRevision === undefined ? {} : { observedRevision },
        outcome: event.data.reason.kind === 'error' ? 'failed' : event.data.reason.kind === 'aborted' ? 'aborted' : 'unknown',
        truncated,
        state: 'active',
      }, bounds.maxRecordChars)
      if (episode !== undefined) episodes.push(episode)
    }
  }
  return episodes
}

/**
 * Find the durable parent turn that created one local child.
 * @param parent - parent Session observation.
 * @param child - child Session identity recorded by the catalog producer.
 * @returns the containing turn, or absent when attribution cannot be verified.
 */
export function parentTurn(parent: SessionLogSnapshot, child: SessionId): number | undefined {
  let turn: number | undefined
  for (const event of parent.events) {
    if (event.seq < parent.inheritedEventCount) continue
    if (event.type === 'turn/start') turn = event.data.turn
    else if (event.type === 'subagent/catalog' && event.data.childId === child) return turn
    else if (event.type === 'turn/end') turn = undefined
  }
  return undefined
}
