/**
 * Durable projection state for the two loop-owned surface messages the system
 * prompt plugin forms: the system prompt (surface node 0 and any in-history
 * replacement) and the dynamic runtime-context snapshot.
 * @module @deepseek-ai/dsh-agent-loop/runtime-context
 */

import { isDeepStrictEqual } from 'node:util'
import { createSystemMessage, createUserMessage, renderRuntimeContextSnapshot } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, ContextSnapshotSection, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, SurfaceIntent, SystemMessage, UserMessage } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': { kind: 'runtime-context' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required-on-read marker for section-level current-context retention. */
    'runtime-context/current-enabled': { retention: 'current' }
  }
}

const SOURCE = 'runtime-context'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

function isOwned(message: UserMessage): boolean {
  return message.source.kind === SOURCE
}

function textOf(message: Message): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

/** One uncommitted system-prompt surface operation for request admission or reconciliation. */
export interface SystemPromptCommit {
  /** Rendered prompt or empty content: an empty head records no prompt; empty tails are dormant. */
  message: SystemMessage
  /** `append` for a new system node, otherwise a replacement of one surviving system node. */
  intent: SurfaceIntent<'system/message'>
}

/** The request-series facts one prompt decision is made under. */
export interface SystemPromptDecisionInput {
  /** Whether the prepared route for this attempt reads a later `system` message as the effective prompt. */
  inHistory: boolean
  /**
   * Whether prompt admission must consolidate: a pre-step listener declared a
   * new series, the surface changed since the last request, or assembled tools
   * changed on a route without tool-update support.
   */
  startsSeries: boolean
}

/** Committed events from the newest backward; the restore scans stop at the first match. */
function eventsNewestFirst(session: Session): readonly SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return session.snapshotEvents().toReversed()
}

/**
 * Decides how a rendered system prompt reaches the surface without owning the
 * commit. The first prompt, even empty, reserves surface node 0.
 * A capable continuing series appends changed nonempty text after the
 * cached history. An incapable route, broken series, or cleared prompt instead
 * normalizes the first system node and empties later active nodes. Dormant empty
 * tails do not supply effective text or require repeated replacements.
 */
export class SystemPromptProjection {
  constructor(private readonly session: Session) {}

  /** The surviving `system/message` nodes in surface order. */
  private systemNodes(): { seq: SessionSeq; text: string | undefined }[] {
    const nodes: { seq: SessionSeq; text: string | undefined }[] = []
    for (const seq of this.session.surface.nodes) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = this.session.eventAt(seq)
      if (event?.type !== 'system/message') continue
      const content = event.data.message.content
      const text = content.length === 0 ? '' : textOf(event.data.message)
      nodes.push({ seq, text })
    }
    return nodes
  }

  /**
   * Reconcile effective text and retained nodes with the prepared route and series.
   * @param rendered - the fully rendered system prompt; `''` when none is active.
   * @param input - the route capability and series facts for this step.
   * @returns ordered per-node updates; an empty list means no update is needed.
   */
  project(rendered: string, input: SystemPromptDecisionInput): SystemPromptCommit[] {
    const nodes = this.systemNodes()
    const head = nodes[0]
    if (head === undefined) {
      return [{ message: createSystemMessage(rendered), intent: { surfaceOp: 'append' } }]
    }
    const latest = nodes.findLast(node => node.text !== '') ?? head
    if (!input.inHistory || input.startsSeries || rendered.length === 0) {
      const updates = nodes.slice(1).filter(node => node.text !== '')
        .map(node => this.replace(node.seq, ''))
      if (head.text !== rendered) updates.push(this.replace(head.seq, rendered))
      return updates
    }
    if (latest.text === rendered) return []
    return [{ message: createSystemMessage(rendered), intent: { surfaceOp: 'append' } }]
  }

  private replace(seq: SessionSeq, text: string): SystemPromptCommit {
    return {
      message: createSystemMessage(text),
      intent: { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    }
  }
}

/** Tracks surviving runtime-context snapshots without owning their commits. */
export class RuntimeContextProjection {
  /** `undefined` means no snapshot ever existed; `null` means none is retained. */
  private retained: { seq: SessionSeq; message: UserMessage } | null | undefined
  private readonly currentSnapshots = new Map<SessionSeq, readonly ContextSnapshotSection[]>()
  private currentEnabled = false

  /**
   * Restore projection state once, then follow authoritative session events.
   * @param ctx - agent-scoped event context.
   * @param session - session receiving projected messages.
   */
  constructor(ctx: Context, session: Session) {
    const surface = new Map(session.surface.nodes.map((seq, index) => [seq, index]))
    let latestPosition = -1
    for (const event of eventsNewestFirst(session)) {
      if (event.type === 'runtime-context/current-enabled') this.currentEnabled = true
      if (event.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      const position = surface.get(event.seq)
      if (position === undefined) continue
      this.rememberCurrent(event.seq, event.data)
      if (position > latestPosition) {
        this.retained = { seq: event.seq, message: event.data }
        latestPosition = position
      }
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'runtime-context/current-enabled') this.currentEnabled = true
      const replacement = isReplacementSurfaceEvent(event)
      if (replacement) {
        const surviving = session.surface.nodes
        for (const seq of this.currentSnapshots.keys()) {
          if (!surviving.includes(seq)) this.currentSnapshots.delete(seq)
        }
        if (this.retained && !surviving.includes(this.retained.seq)) this.retained = null
      }
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained ??= null
        this.rememberCurrent(event.seq, event.data)
        if (isAppendSurfaceEvent(event) || (replacement && this.retained === null)) {
          this.retained = { seq: event.seq, message: event.data }
        }
      }
    })
  }

  private rememberCurrent(seq: SessionSeq, message: UserMessage): void {
    const source = message.source
    if (source.kind === SOURCE && source.form === 'snapshot'
      && source.sections.some(section => section.retention === 'current')) this.currentSnapshots.set(seq, source.sections)
  }

  /**
   * Create an uncommitted snapshot only when the retained value differs.
   * @param current - fully rendered dynamic context.
   * @param sections - named contributions that formed the current snapshot.
   * @returns a candidate user message, or `undefined` when no update is needed.
   */
  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained !== undefined && this.retained !== null && textOf(this.retained.message) === snapshot) {
      const source = this.retained.message.source
      const previous = source.kind === SOURCE && source.form === 'snapshot' ? source.sections : []
      if (!previous.some(section => section.retention === 'current') && !sections.some(section => section.retention === 'current')) return
      if (isDeepStrictEqual(previous, sections)) return
    }
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      // The cleared marker has no contributions left to attribute.
      source: sections.length === 0
        ? { kind: SOURCE }
        : { kind: SOURCE, form: 'snapshot', sections },
    })
  }

  /**
   * Plan request admission after providers refresh. Old current sections are
   * replaced per node; historical sections and raw log events remain intact.
   * The latest unchanged complete snapshot can stay in place.
   * @param current - fully rendered refreshed context.
   * @param sections - refreshed named contributions, including retention.
   * @returns logged replacements and the optional fresh snapshot to admit.
   */
  reconcile(current: string, sections: readonly ContextSnapshotSection[]): {
    enableCurrent: boolean
    replacements: { message: UserMessage; intent: SurfaceIntent<'user/message'> }[]
    message: UserMessage | undefined
  } {
    const message = this.project(current, sections)
    const keep = message === undefined ? this.retained?.seq : undefined
    const replacements: { message: UserMessage; intent: SurfaceIntent<'user/message'> }[] = []
    for (const [seq, previous] of this.currentSnapshots) {
      if (seq === keep) continue
      const history = previous.filter(section => section.retention !== 'current')
      replacements.push({
        message: createUserMessage({
          content: [{ type: 'text', text: history.length === 0 ? CLEARED : renderRuntimeContextSnapshot(history) }],
          source: { kind: SOURCE, form: 'snapshot', sections: history },
        }),
        intent: { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
      })
    }
    return {
      enableCurrent: !this.currentEnabled && sections.some(section => section.retention === 'current'),
      replacements,
      message,
    }
  }
}
