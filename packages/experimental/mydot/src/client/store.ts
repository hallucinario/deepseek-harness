/** Per-conversation drafts and exact routing survive navigation and reload. */
import type { StartJob } from '../types.ts'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent/client'

/** Stable request retained after an uncertain send; reconnect never sends it automatically. */
export interface PendingInput { requestId: SubagentPromptRequestId; text: string; target: SessionId | null; delivery: 'steer' | 'queue' }
/** Viewing state only; execution facts come from the Host stream. */
export interface DraftState {
  creating: boolean
  names: [string, string]
  requests: [string, string]
  starts: StartJob[] | null
  expanded: boolean
  text: string
  target: SessionId | null
  delivery: 'steer' | 'queue'
  pending: PendingInput | null
  receipt: boolean
  stopping: Record<string, boolean>
}
const actions = {
  creating: (draft: DraftState, value: boolean) => { draft.creating = value },
  name: (draft: DraftState, index: number, text: string) => { draft.names[index] = text },
  request: (draft: DraftState, index: number, text: string) => { draft.requests[index] = text },
  starting: (draft: DraftState, jobs: StartJob[]) => { draft.starts = jobs },
  started: (draft: DraftState) => { draft.starts = null; draft.creating = false; draft.names = ['', '']; draft.requests = ['', ''] },
  expand: (draft: DraftState, expanded: boolean) => { draft.expanded = expanded },
  text: (draft: DraftState, text: string) => { draft.text = text; draft.receipt = false },
  target: (draft: DraftState, target: SessionId | null) => { draft.target = target; draft.receipt = false },
  delivery: (draft: DraftState, delivery: 'steer' | 'queue') => { draft.delivery = delivery },
  pending: (draft: DraftState, pending: PendingInput) => { draft.pending = pending },
  accepted: (draft: DraftState) => { draft.pending = null; draft.text = ''; draft.receipt = true },
  stopping: (draft: DraftState, child: SessionId) => { draft.stopping[child] = true },
}

/** Create a scope-keyed viewing store for the slot runtime.
 * @returns Uninstantiated store declaration.
 */
export function createMyDotStore(): EngineStoreHandle<DraftState, typeof actions> {
  return defineStore({
    init: (): DraftState => ({ creating: false, names: ['', ''], requests: ['', ''], starts: null, expanded: false, text: '', target: null, delivery: 'queue', pending: null, receipt: false, stopping: {} }),
    persist: 'dsh.mydot.draft.v1',
    actions,
  })
}
