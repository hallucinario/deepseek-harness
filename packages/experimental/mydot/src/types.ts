/** Browser-safe MyDot view data projected from existing Session records. */
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
/** Opaque Space identity independent of a display name. */
export type SpaceId = Branded<'MyDotSpaceId'>
/** Durable small Space metadata. */
export interface Space {
  id: SpaceId
  name: string
  purpose: string
  instructions: string
  materials: string[]
  workspaceId?: WorkspaceId | undefined
  archived: boolean
  revision: number
}
/** New metadata or an optimistic replacement. */
export type SpaceInput = Omit<Space, 'id' | 'revision' | 'archived'> & { id?: SpaceId; revision?: number; archived?: boolean }
/** Local continuation creation, identified independently of its label. */
export interface StartJob { parentSessionId: SessionId; requestId: SessionRequestId; label: string; prompt: string; provider: 'spawn' | 'fork' }
/** Explicit memory isolation scope. */
export type MemoryScope = { kind: 'personal' } | { kind: 'space'; spaceId: SpaceId }
/** State of one execution-world desktop, independent of file-only work. */
export interface DesktopState { phase: 'free' | 'agent' | 'stopping' | 'human'; owner?: SessionId; capturedAt?: number; inFlight: number }


/** A job is an existing direct child, never another task record. */
export interface MyDotJobView {
  parentSessionId: SessionId
  childSessionId: SessionId
  label: string
  mode: 'continuable' | 'one-shot' | 'external' | 'unknown'
  request?: string | undefined
  summary?: string | undefined
  status: 'running' | 'inactive'
}
/** Source coordinates and current file availability for a durable declaration. */
export interface ArtifactView {
  sessionId: SessionId
  parentSessionId: SessionId
  path: string
  description?: string
  available: boolean
}
/** All lists are reconstructed; only Space metadata and Session links are new storage. */
export interface MyDotSnapshot {
  spaces: Space[]
  conversations: { sessionId: SessionId; spaceId: Space['id']; cwd: string }[]
  jobs: MyDotJobView[]
  artifacts: ArtifactView[]
  desktop: DesktopState
  desktopEnabled?: boolean
  issues?: { sessionId: SessionId; kind: 'unavailable' | 'artifact-delivery' }[]
}

import type { FsVersion } from '@deepseek-ai/dsh-fs/types'
/** A current file read, with absence distinct from unreadability. */
export type TextRead =
  | { kind: 'text'; path: string; content: string; version: FsVersion }
  | { kind: 'missing'; path: string }
/** Full-file edit carrying the exact version the user observed. */
export interface TextSave { path: string; content: string; version: FsVersion | null }
/** Conflict preserves both draft and current contents; no write occurred. */
export type TextSaveResult =
  | { kind: 'saved'; path: string; version: FsVersion; content: string }
  | { kind: 'conflict'; path: string; draft: string; current: TextRead }


import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent/client'
/** Text routed to one exact continuable child. */
export interface JobInput { parentSessionId: SessionId; childSessionId: SessionId; requestId: SubagentPromptRequestId; delivery: 'steer' | 'queue'; text: string }
/** Exact direct-parent ownership address. */
export interface JobAddress { parentSessionId: SessionId; childSessionId: SessionId }
