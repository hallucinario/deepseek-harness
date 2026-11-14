/** Slot-derived props and plain MyDot application commands. */
import type { HostObservable, PropsLocale, PropsRuntime, PropsStore, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Space, SpaceId, SpaceInput } from '../types.ts'
import type { MyDotSnapshot, MyDotJobView, ArtifactView } from '../types.ts'
import type { TextRead, TextSave, TextSaveResult } from '../types.ts'
import type { MemoryScope, StartJob } from '../types.ts'
import type { HumanAnswer, HumanRequestId } from '../types.ts'
import type { PendingInput, createMyDotStore } from './store.ts'
import type { NS } from './locales.ts'

/** Connection failure is visible separately from an empty loaded list. */
export type ViewState = { phase: 'loading' } | { phase: 'ready'; value: MyDotSnapshot; disconnected?: boolean } | { phase: 'failed'; message: string }
/** Apply-time command values; no service objects or React values cross this face. */
export interface Commands {
  filingCommand?: (command: import('./Filing.tsx').FilingCommand, filing: import('../filing-types.ts').FilingView, externalControlsClosed?: boolean) => Promise<void>
  hooks: { mydot: HostObservable<ViewState> }
  retry: () => void
  presentResults: (sessionId: SessionId) => Promise<void>
  releaseDesktop: (sessionId: SessionId) => Promise<void>
  saveSpace: (input: SpaceInput) => Promise<Space>
  createConversation: (spaceId: SpaceId) => Promise<void>
  attach: (sessionId: SessionId, spaceId: SpaceId) => Promise<void>
  startJob: (input: StartJob) => Promise<void>
  send: (sessionId: SessionId, input: PendingInput) => Promise<void>
  stop: (job: MyDotJobView) => Promise<void>
  open: (job: MyDotJobView) => void
  openConversation: (sessionId: SessionId) => void
  preview: (artifact: ArtifactView) => void
  flushPreview: (sessionId: SessionId) => void
  readFile: (sessionId: SessionId, path: string) => Promise<TextRead>
  saveFile: (sessionId: SessionId, edit: TextSave) => Promise<TextSaveResult>
  readMemory: (scope: MemoryScope) => Promise<TextRead>
  saveMemory: (scope: MemoryScope, edit: Omit<TextSave, 'path'>) => Promise<TextSaveResult>
  continueFile: (sessionId: SessionId, path: string, version: import('@deepseek-ai/dsh-fs/types').FsVersion) => Promise<void>
  handoff: () => Promise<void>
  resume: (owner: SessionId, capturedAt: number) => Promise<void>
  newRequestId: () => string
  answerHumanRequest?: (answer: HumanAnswer) => Promise<void>
  reconcileHumanRequest?: (requestId: HumanRequestId) => Promise<void>
  cancelHumanRequest?: (requestId: HumanRequestId) => Promise<void>
  selectedHumanRequestId?: string
}
/** Renderer turns the declared observable into its subscribed selector hook. */
export type Injected = InjectFace<Commands>
/** Conversation-scoped dock and persisted viewing state. */
export type DockProps = Pick<PropsRuntime<'conversation.input.dock'>, 'sessionId'> & PropsLocale<typeof NS> & PropsStore<ReturnType<typeof createMyDotStore>> & Injected
/** Global panel uses the same Host source and navigation commands. */
export type PanelProps = Pick<PropsRuntime<'main'>, 'useWorkspaces'> & PropsLocale<typeof NS> & Injected
