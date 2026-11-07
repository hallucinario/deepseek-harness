// @vitest-environment jsdom
/** Workspace names and paths remain separate from exact saved execution associations. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, workspaceSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { MyDotPanel } from '../src/client/Panel.tsx'
import { createEditorStore } from '../src/client/editor-store.ts'
import type { ViewState } from '../src/client/props.ts'
import type { Space, SpaceId, SpaceInput } from '../src/types.ts'
import { ja } from '../src/client/locales.ts'
import { clientCommands } from './client-commands.client.ts'

afterEach(() => { cleanup(); localStorage.clear() })
const research: WorkspaceView = { workspaceId: 'opaque-research-01' as WorkspaceId, title: '調査資料', path: '/Users/test/調査', sessionIds: [], createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' }
const defaultWorkspace: WorkspaceView = { ...research, workspaceId: 'opaque-default-02' as WorkspaceId, title: 'default-workspace', path: '/Documents/deepseek-harness/default-workspace' }
const saved: Space = { id: 'space-existing' as SpaceId, name: '保存済み', purpose: '調査', instructions: '', materials: [], workspaceId: research.workspaceId, archived: false, revision: 3 }
function workspaceState(overrides: Partial<WorkspaceSnapshot>): WorkspaceSnapshot { return { ...workspaceSnapshot(), ...overrides } }
function setup(space?: Space) {
  const editor = createEditorStore().create('workspace-selector')
  if (space !== undefined) editor.actions.select(space.id)
  const workspaces = createSnapshotStore(workspaceState({ items: [research, defaultWorkspace] }))
  const source = createSnapshotStore<ViewState>({ phase: 'ready', value: { spaces: space === undefined ? [] : [space], conversations: [], jobs: [], artifacts: [], desktop: { phase: 'free', inFlight: 0 } } })
  const saveSpace = vi.fn(async (input: SpaceInput): Promise<Space> => ({ id: saved.id, archived: false, revision: 4, ...input }))
  const props = {
    ...clientCommands(),
    useMydot: bindSnapshotSelector(source), useWorkspaces: bindSnapshotSelector(workspaces), useStore: bindSnapshotSelector(editor),
    actions: editor.actions, t: makeTranslate(ja), saveSpace, retry: vi.fn(),
  } satisfies ComponentProps<typeof MyDotPanel>
  render(<MyDotPanel {...props} />)
  return { workspaces, saveSpace, source }
}
function selector() { return screen.getByRole<HTMLSelectElement>('combobox', { name: ja.workspace }) }
async function save(name = ja.save) { await act(async () => { fireEvent.click(screen.getByRole('button', { name })) }) }

it('starts unselected and creates a Space with the exact WorkspaceId chosen by Japanese name and path', async () => {
  const b = setup()
  expect(selector().value).toBe('')
  expect(within(selector()).getByRole<HTMLOptionElement>('option', { name: 'Workspace 未選択（既定の実行先）' })).toBeTruthy()
  expect(within(selector()).getByRole<HTMLOptionElement>('option', { name: '調査資料 · /Users/test/調査' }).value).toBe(research.workspaceId)
  expect(within(selector()).getByRole<HTMLOptionElement>('option', { name: '既定の Workspace · /Documents/deepseek-harness/default-workspace' }).value).toBe(defaultWorkspace.workspaceId)
  expect(screen.queryByRole('textbox', { name: ja.workspace })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: ja.name }), { target: { value: '新しい調査' } })
  fireEvent.change(selector(), { target: { value: research.workspaceId } })
  await save(ja.create)
  expect(b.saveSpace).toHaveBeenCalledWith(expect.objectContaining({ name: '新しい調査', workspaceId: research.workspaceId }))
})

it('keeps the initial default execution choice explicit and saves no invented WorkspaceId', async () => {
  const b = setup()
  fireEvent.change(screen.getByRole('textbox', { name: ja.name }), { target: { value: '既定の作業' } })
  await save(ja.create)
  expect(b.saveSpace.mock.calls[0]?.[0].workspaceId).toBeUndefined()
})

it('shows the saved directory by name and path and edits it to another exact registered WorkspaceId', async () => {
  const b = setup(saved)
  expect(selector().value).toBe(research.workspaceId)
  expect(screen.getByText('調査資料 · /Users/test/調査', { selector: 'p' })).toBeTruthy()
  fireEvent.change(selector(), { target: { value: defaultWorkspace.workspaceId } })
  await save()
  expect(b.saveSpace).toHaveBeenCalledWith(expect.objectContaining({
    id: saved.id, revision: saved.revision, workspaceId: defaultWorkspace.workspaceId,
  }))
  fireEvent.change(selector(), { target: { value: '' } })
  await save()
  expect(b.saveSpace.mock.lastCall?.[0].workspaceId).toBeUndefined()
})

it('retains a missing historical association while saving other metadata and allows explicit replacement', async () => {
  const missing = 'removed-historical-id' as WorkspaceId
  const b = setup({ ...saved, workspaceId: missing })
  expect(selector().value).toBe(missing)
  expect(within(selector()).getByRole<HTMLOptionElement>('option', { name: '利用できない Workspace（関連付けは保持されています）' }).value).toBe(missing)
  expect(within(selector()).getByRole<HTMLOptionElement>('option', { name: '利用できない Workspace（関連付けは保持されています）' }).disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: ja.purpose }), { target: { value: '新しい目的' } })
  await save()
  expect(b.saveSpace).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: missing, purpose: '新しい目的' }))
  fireEvent.change(selector(), { target: { value: research.workspaceId } })
  await save()
  expect(b.saveSpace.mock.lastCall?.[0].workspaceId).toBe(research.workspaceId)
})

it('preserves archived Space associations and localizes the archived Space marker', async () => {
  const b = setup({ ...saved, archived: true })
  expect(screen.getByRole<HTMLOptionElement>('option', { name: '保存済み · アーカイブ済み' })).toBeTruthy()
  expect(selector().value).toBe(research.workspaceId)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: ja.start }).disabled).toBe(true)
  await save()
  expect(b.saveSpace).toHaveBeenCalledWith(expect.objectContaining({ archived: true, workspaceId: research.workspaceId }))
})

it('subscribes to snapshot arrivals, renames and removal without resetting the selected association', async () => {
  const b = setup(saved)
  act(() => { b.workspaces.set(workspaceState({ items: [{ ...research, title: '改名済み' }, defaultWorkspace] })) })
  expect(selector().value).toBe(research.workspaceId)
  expect(screen.getByText('改名済み · /Users/test/調査', { selector: 'p' })).toBeTruthy()
  act(() => { b.workspaces.set(workspaceState({ items: [defaultWorkspace] })) })
  expect(selector().value).toBe(research.workspaceId)
  // A stale selection event for the removed registration cannot replace its saved association.
  fireEvent.change(selector(), { target: { value: research.workspaceId } })
  await save()
  expect(b.saveSpace.mock.lastCall?.[0].workspaceId).toBe(research.workspaceId)
  act(() => { b.workspaces.set(workspaceState({ items: [research, defaultWorkspace] })) })
  expect(within(selector()).queryByRole('option', { name: '利用できない Workspace（関連付けは保持されています）' })).toBeNull()
  expect(selector().value).toBe(research.workspaceId)
})

it('shows loading and stream failure without silently clearing an existing association', async () => {
  const b = setup(saved)
  act(() => { b.workspaces.set(workspaceState({ phase: 'pending', state: 'loading', items: [] })) })
  expect(selector().disabled).toBe(true)
  expect(screen.getByText('Workspace を読み込み中…', { selector: '[role="status"]' })).toBeTruthy()
  expect(selector().value).toBe(research.workspaceId)
  await save()
  expect(b.saveSpace.mock.lastCall?.[0].workspaceId).toBe(research.workspaceId)
  act(() => { b.workspaces.set(workspaceState({ state: 'error', items: [research] })) })
  expect(selector().disabled).toBe(true)
  expect(screen.getByRole('alert').textContent).toBe('Workspace を読み込めません。関連付けは保持されています。')
  await save()
  expect(b.saveSpace.mock.lastCall?.[0].workspaceId).toBe(research.workspaceId)
})

it('shows an empty registered list without choosing a folder on the user’s behalf', () => {
  const b = setup()
  act(() => { b.workspaces.set(workspaceState({ items: [] })) })
  expect(selector().value).toBe('')
  expect(screen.getByText('登録済みの Workspace はありません。', { selector: '[role="status"]' })).toBeTruthy()
})
