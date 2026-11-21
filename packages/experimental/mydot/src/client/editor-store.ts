/** Persist only document viewing state and user drafts across navigation and reload. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FsVersion } from '@deepseek-ai/dsh-fs/types'
import type { MemoryScope, SpaceId } from '../types.ts'

/** One explicitly opened text source and its unsaved user draft. */
export type EditorDraft = {
  path: string
  version: FsVersion | null
  saved: string
  draft: string
  conflict: string | null
} & ({ sessionId: SessionId; scope: null } | { sessionId: null; scope: MemoryScope })
/** Root-panel viewing preferences are independent of execution state. */
interface PanelState {
  spaceId: SpaceId | null
  editor: EditorDraft | null
  /** Earlier persisted v1 editor values have no human drafts. */
  humanDrafts?: Record<string, { choice: string; text: string; submissionId: string }>
}
const actions = {
  select: (state: PanelState, id: SpaceId | null) => { state.spaceId = id },
  humanDraft: (state: PanelState, key: string, draft: { choice: string; text: string; submissionId: string }) => {
    (state.humanDrafts ??= {})[key] = draft
  },
  open: (state: PanelState, editor: EditorDraft) => {
    if (state.editor !== null && state.editor.draft !== state.editor.saved) throw new Error('Save or discard the open draft first')
    state.editor = editor
  },
  draft: (state: PanelState, text: string) => { if (state.editor !== null) state.editor.draft = text },
  discard: (state: PanelState) => { if (state.editor !== null) state.editor.draft = state.editor.saved },
  close: (state: PanelState) => { if (state.editor !== null && state.editor.draft !== state.editor.saved) throw new Error('Save or discard the open draft first'); state.editor = null },
  saved: (state: PanelState, version: FsVersion, content: string) => {
    if (state.editor !== null) {
      state.editor.version = version
      state.editor.saved = content
      state.editor.draft = content
      state.editor.conflict = null
    }
  },
  conflict: (state: PanelState, version: FsVersion | null, current: string) => {
    if (state.editor !== null) { state.editor.version = version; state.editor.conflict = current }
  },
}

/** Declare shared root-panel interaction state for the renderer.
 * @returns Store declaration; instances are created by the Slot runtime.
 */
export function createEditorStore(): EngineStoreHandle<PanelState, typeof actions> {
  return defineStore({
    init: (): PanelState => ({ spaceId: null, editor: null, humanDrafts: {} }),
    persist: 'dsh.mydot.editor.v1',
    actions,
  })
}
