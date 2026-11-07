/** MyDot deduplicates browser requests from existing inbox history before Subagent admission. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentPromptReceipt, SubagentInterruptReceipt } from '@deepseek-ai/dsh-subagent'

import type { JobInput, JobAddress } from './types.ts'
export type { JobInput, JobAddress } from './types.ts'

/** Per-child admission preserves Subagent authority and uses its durable message identity. */
export class JobControls {
  private readonly pending = new Map<SessionId, Promise<void>>()
  constructor(private readonly ctx: Context) {}

  /** Admit text once by checking consumed and pending durable inbox messages.
   * @param request - Exact IDs, stable caller-minted request ID and desired inbox destination.
   * @param signal - Cancellation before admission.
   * @returns Inbox receipt, not proof of consumption or output correctness.
   */
  send(request: JobInput, signal: AbortSignal): Promise<SubagentPromptReceipt> {
    const previous = this.pending.get(request.childSessionId) ?? Promise.resolve()
    const work = previous.then(async () => {
      signal.throwIfAborted()
      const children = await this.ctx.subagents.listChildren(request.parentSessionId, signal)
      if (!children.some(child => child.id === request.childSessionId && child.mode === 'continuable')) throw new Error('Select a direct continuable child')
      using source = await this.ctx.sessionQuery.observeSession(request.childSessionId)
      for (const event of source.events.slice(source.inheritedEventCount)) {
        const messages = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
        const found = messages.find(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === request.requestId)
        if (found !== undefined) {
          if (found.content.length !== 1 || found.content[0]?.type !== 'text' || found.content[0].text !== request.text) throw new Error('Request identity was reused with different input')
          return { messageId: found.id }
        }
      }
      return await this.ctx.subagents.prompt({
        parentSessionId: request.parentSessionId, childSessionId: request.childSessionId,
        requestId: request.requestId, mode: 'continuable', delivery: request.delivery,
        content: [{ type: 'text', text: request.text }],
      }, signal)
    })
    const settled = work.then(() => undefined, () => undefined)
    this.pending.set(request.childSessionId, settled)
    void settled.then(() => { if (this.pending.get(request.childSessionId) === settled) this.pending.delete(request.childSessionId) })
    return work
  }

  /** Request cancellation without changing pending inbox items.
   * @param address - Exact owning parent and child.
   * @returns Admission only; observe live status for completion.
   */
  stop(address: JobAddress): SubagentInterruptReceipt {
    return this.ctx.subagents.interruptByParent(address.childSessionId, address.parentSessionId, 'continuable')
  }
}
