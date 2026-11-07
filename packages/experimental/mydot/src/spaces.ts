/** Serializes Space edits and one-time Session classification without rewriting Session history. */
import { randomUUID } from 'node:crypto'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SpaceId, spaceSchema, type mydotDomain, type Space, type SpaceInput } from './storage.ts'

/** Domain-local owner for Space writes; no derived reverse index is persisted. */
export class Spaces {
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly domain: Domain<typeof mydotDomain>) {}

  /** List archived and visible Spaces.
   * @returns Current committed metadata.
   */
  list(): Space[] { return [...this.domain.table('spaces').entries()].map(([, value]) => value) }

  /** Resolve the immutable classification of a Session.
   * @param sessionId - Original Session identity.
   * @returns Associated Space; absent when the Session has no association.
   */
  forSession(sessionId: SessionId): Space | undefined {
    const link = this.domain.table('sessions').get(sessionId)
    return link === undefined ? undefined : this.domain.table('spaces').get(link.spaceId)
  }

  /** Create or replace observed Space metadata.
   * @param input - New metadata or a replacement carrying its observed revision.
   * @returns Durably committed Space.
   */
  save(input: SpaceInput): Promise<Space> {
    return this.serialize(async () => {
      const id = input.id ?? SpaceId(randomUUID())
      const current = this.domain.table('spaces').get(id)
      if (input.id !== undefined && current === undefined) throw new Error('Space not found')
      if (current !== undefined && input.revision !== current.revision) throw new Error('Space changed; reload before saving')
      const record = spaceSchema.parse({ ...input, id, revision: (current?.revision ?? 0) + 1, archived: input.archived ?? false })
      await this.domain.table('spaces').put(id, record)
      return record
    })
  }

  /** Bind a new Session once; an identical association is an idempotent no-op.
   * @param sessionId - Session whose cwd and history are retained.
   * @param spaceId - Non-archived Space.
   * @returns Resolution after the sole authoritative link commits.
   */
  attach(sessionId: SessionId, spaceId: SpaceId): Promise<void> {
    return this.serialize(async () => {
      const existing = this.domain.table('sessions').get(sessionId)
      if (existing !== undefined) {
        if (existing.spaceId === spaceId) return
        throw new Error('Session already belongs to another Space; start a new conversation')
      }
      const space = this.domain.table('spaces').get(spaceId)
      if (space === undefined) throw new Error('Space not found')
      if (space.archived) throw new Error('Space is archived')
      await this.domain.table('sessions').put(sessionId, { spaceId })
    })
  }

  /** Inherit an existing parent's association, including archived ongoing work.
   * @param parent - Already classified parent.
   * @param child - Newly accepted local child.
   * @returns Resolution after the authoritative association commits.
   */
  inherit(parent: SessionId, child: SessionId): Promise<void> {
    return this.serialize(async () => {
      const binding = this.domain.table('sessions').get(parent)
      if (binding === undefined) return
      const existing = this.domain.table('sessions').get(child)
      if (existing !== undefined && existing.spaceId !== binding.spaceId) throw new Error('Child belongs to another Space')
      if (existing === undefined) await this.domain.table('sessions').put(child, binding)
    })
  }

  /** Drain accepted writes before domain closure.
   * @returns Resolution once all accepted writes settle.
   */
  async drain(): Promise<void> { await this.chain }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work)
    this.chain = run.catch(() => undefined)
    return run
  }
}
