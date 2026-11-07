// @vitest-environment jsdom
/** Drafts stay in the viewing store when a versioned save conflicts or the panel remounts. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FsVersion } from '@deepseek-ai/dsh-fs/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, workspaceSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { MyDotPanel } from '../src/client/Panel.tsx'
import { createEditorStore } from '../src/client/editor-store.ts'
import type { ViewState } from '../src/client/props.ts'
import { ja } from '../src/client/locales.ts'
import { clientCommands } from './client-commands.client.ts'

afterEach(cleanup)
it('keeps a Japanese memory draft and the current conflicting version across navigation, then saves the merged text', async () => {
  const state = createEditorStore().create('root')
  const source = createSnapshotStore<ViewState>({ phase: 'ready', value: { spaces: [], conversations: [], jobs: [], artifacts: [], desktop: { phase: 'free', inFlight: 0 } } })
  const saveMemory = vi.fn().mockResolvedValueOnce({ kind: 'conflict', draft: '私の草稿', path: '/MyDot/MEMORY.md', current: { kind: 'text', path: '/MyDot/MEMORY.md', content: '別タブの変更', version: FsVersion('current') } })
    .mockResolvedValueOnce({ kind: 'saved', content: '統合した内容', path: '/MyDot/MEMORY.md', version: FsVersion('saved') })
  const props = {
    ...clientCommands(),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore(workspaceSnapshot())),
    useMydot: bindSnapshotSelector(source), useStore: bindSnapshotSelector(state),
    actions: state.actions, t: makeTranslate(ja),
    readMemory: vi.fn(async () => ({ kind: 'text' as const, path: '/MyDot/MEMORY.md', content: 'original', version: FsVersion('original') })),
    saveMemory, saveSpace: vi.fn(), retry: vi.fn(), handoff: vi.fn(),
  } satisfies ComponentProps<typeof MyDotPanel>
  const first = render(<MyDotPanel {...props} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: ja.personal })) })
  fireEvent.change(screen.getByRole('textbox', { name: ja.edit }), { target: { value: '私の草稿' } })
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: ja.save }).at(-1)!) })
  expect(screen.getByText('別タブの変更')).toBeTruthy()
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: ja.edit }).value).toBe('私の草稿')
  first.unmount()
  render(<MyDotPanel {...props} />)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: ja.edit }).value).toBe('私の草稿')
  fireEvent.change(screen.getByRole('textbox', { name: ja.edit }), { target: { value: '統合した内容' } })
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: ja.save }).at(-1)!) })
  expect(saveMemory.mock.calls[1]?.[1]).toMatchObject({ content: '統合した内容', version: 'current' })
  expect(screen.queryByText(ja.dirty)).toBeNull()
})
