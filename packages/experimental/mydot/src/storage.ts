/** MyDot's authoritative Space records and immutable Session associations. */
import { z } from 'zod'
import type { SpaceId as SpaceKey } from './types.ts'
export type { Space, SpaceInput } from './types.ts'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Opaque Space identity independent of its display name. */
export type SpaceId = SpaceKey
/** Brand a stored or newly generated Space key.
 * @param value - Opaque key.
 * @returns Branded key.
 */
export function SpaceId(value: string): SpaceId { return value as SpaceId }

/** Validated durable Space metadata; archive preserves references. */
export const spaceSchema = z.object({
  id: z.string().min(1).transform(SpaceId),
  name: z.string().trim().min(1),
  purpose: z.string(),
  instructions: z.string(),
  materials: z.array(z.string().min(1)),
  workspaceId: z.string().min(1).transform(WorkspaceId).optional(),
  archived: z.boolean(),
  revision: z.number().int().positive(),
}).strict()

/** Small records only; Sessions and their logs remain execution authority. */
export const mydotDomain = defineDomain({
  name: 'mydot', version: 1,
  tables: {
    spaces: domainTable<SpaceId, z.infer<typeof spaceSchema>>(spaceSchema),
    sessions: domainTable<SessionId, { spaceId: SpaceId }>(z.object({ spaceId: z.string().min(1).transform(SpaceId) }).strict()),
  },
})
