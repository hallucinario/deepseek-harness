/** Durable, source-referenced experience records and frozen work selections. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Deterministic identity of a locally observed session turn. */
export type EpisodeId = Branded<'ExperienceEpisodeId'>
/** Root human task or goal shared by its delegated work. */
export type WorkGroupId = Branded<'ExperienceWorkGroupId'>
/** Exact original-project and effective-directory pair. */
export type ScopeId = Branded<'ExperienceScopeId'>
/** Opaque durable identity of one Session, scope, and work-group selection. */
export type SelectionId = Branded<'ExperienceSelectionId'>

/** Parsed episode identity; an empty value is never a reference. */
export const episodeIdSchema = z.string().min(1).transform(brandString<EpisodeId>)
/** Parsed task identity. */
export const workGroupIdSchema = z.string().min(1).transform(brandString<WorkGroupId>)
/** Parsed scope identity. */
export const scopeIdSchema = z.string().min(1).transform(brandString<ScopeId>)
const seqSchema = z.number().int().nonnegative().transform(SessionSeq)

/** Host-derived directories retained with every record. */
export const scopeSchema = z.object({
  id: scopeIdSchema,
  projectCwd: z.string().min(1),
  effectiveCwd: z.string().min(1),
}).strict()

/** One bounded original tool operation or result; never assistant reasoning. */
export const observationSchema = z.object({
  kind: z.enum(['operation', 'result', 'error']),
  eventSeq: seqSchema,
  tool: z.string(),
  text: z.string(),
}).strict()

/** Version-one record; retirement preserves the deterministic source identity. */
export const episodeSchema = z.object({
  id: episodeIdSchema,
  scope: scopeSchema,
  groupId: workGroupIdSchema,
  sessionId: z.string().min(1).transform(SessionId),
  turn: z.number().int().positive(),
  startSeq: seqSchema,
  endSeq: seqSchema,
  capturedAt: z.number().nonnegative(),
  request: z.object({ eventSeq: seqSchema, text: z.string() }).strict(),
  observations: z.array(observationSchema),
  observedRevision: z.string().optional(),
  outcome: z.enum(['unknown', 'failed', 'aborted']),
  truncated: z.boolean(),
  state: z.enum(['active', 'retired']),
  retiredAt: z.number().nonnegative().optional(),
}).strict()

/** A selection is durable before it can become model-visible. */
export const selectionSchema = z.object({
  sessionId: z.string().min(1).transform(SessionId),
  scope: scopeSchema,
  groupId: workGroupIdSchema,
  episodeIds: z.array(episodeIdSchema),
  text: z.string(),
}).strict()

/** Validated stored experience. */
export type Episode = z.infer<typeof episodeSchema>
/** Validated frozen selection. */
export type Selection = z.infer<typeof selectionSchema>
/** Host scope captured independently of model text. */
export type ExperienceScope = z.infer<typeof scopeSchema>

/** Authoritative episodes and selections; invalid records fail the entire open. */
export const experienceDomain = defineDomain({
  name: 'memory_experience',
  version: 1,
  tables: {
    episodes: domainTable<EpisodeId, Episode>(episodeSchema),
    selections: domainTable<SelectionId, Selection>(selectionSchema),
  },
})
