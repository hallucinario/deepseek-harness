// @vitest-environment jsdom
/** User-facing failure, draft, Space and desktop controls retain exact source coordinates. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { bindSnapshotSelector, makeTranslate, workspaceSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { FsVersion } from '@deepseek-ai/dsh-fs/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SpaceId, MyDotSnapshot, SpaceInput, HumanRequestView, HumanRequestId } from '../src/types.ts'
import { MyDotDock } from '../src/client/Dock.tsx'
import { MyDotPanel } from '../src/client/Panel.tsx'
import { createMyDotStore } from '../src/client/store.ts'
import { createEditorStore } from '../src/client/editor-store.ts'
import type { Commands, ViewState } from '../src/client/props.ts'
import { ja } from '../src/client/locales.ts'

afterEach(() => { cleanup()
  localStorage.clear() })
const parent = 'parent' as SessionId
const child = 'child' as SessionId
const spaceId = 'space' as SpaceId
function bench() {
  const snapshot: MyDotSnapshot = { spaces: [{ id: spaceId, name: 'Research', purpose: 'Read', instructions: 'Summarize', materials: ['/source'], archived: false, revision: 1 }], conversations: [{ sessionId: parent, spaceId, cwd: '/work' }], jobs: [{ parentSessionId: parent, childSessionId: child, label: 'Worker', mode: 'continuable', status: 'running', request: 'Read source', summary: 'Working' }], artifacts: [{ sessionId: parent, parentSessionId: parent, path: '/report', available: true }, { sessionId: parent, parentSessionId: parent, path: '/missing', available: false }], desktop: { phase: 'agent', owner: parent, capturedAt: 1000, inFlight: 0 }, desktopEnabled: true }
  const source = createSnapshotStore<ViewState>({ phase: 'ready', value: snapshot })
  const dock = createMyDotStore().create('coverage')
  const editor = createEditorStore().create('coverage')
  const read = { kind: 'text' as const, path: '/report', content: 'Original', version: FsVersion('v1') }
  const commands = { retry: vi.fn(), newRequestId: vi.fn(() => 'request'), presentResults: vi.fn(async () => {}), releaseDesktop: vi.fn(async () => {}), saveSpace: vi.fn(async (input: SpaceInput) => ({ ...snapshot.spaces[0]!, ...input })),
    createConversation: vi.fn(async () => {}), attach: vi.fn(async () => {}), startJob: vi.fn(async () => {}), send: vi.fn(async () => {}), stop: vi.fn(async () => {}), open: vi.fn(), openConversation: vi.fn(), preview: vi.fn(), flushPreview: vi.fn(), readFile: vi.fn(async () => read), saveFile: vi.fn(async () => ({ ...read, kind: 'saved' as const, content: 'Saved' })), readMemory: vi.fn(async () => read), saveMemory: vi.fn(async () => ({ ...read, kind: 'saved' as const })), continueFile: vi.fn(async () => {}), handoff: vi.fn(async () => {}), resume: vi.fn(async () => {}) } satisfies Omit<Commands, 'hooks'>
  const common = { ...commands, useWorkspaces: bindSnapshotSelector(createSnapshotStore({ ...workspaceSnapshot(), items: [{ workspaceId: 'workspace' as WorkspaceId, title: 'Workspace', path: '/work', sessionIds: [], createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' }] })), useMydot: bindSnapshotSelector(source), t: makeTranslate(ja) }
  return { snapshot, source, dock, editor, commands, common,
    dockProps: {
      ...common, sessionId: parent, useStore: bindSnapshotSelector(dock), actions: dock.actions,
    } as ComponentProps<typeof MyDotDock>,
    panelProps: { ...common, useStore: bindSnapshotSelector(editor), actions: editor.actions } as ComponentProps<typeof MyDotPanel>,
  }
}
async function click(name: string) { await act(async () => { fireEvent.click(screen.getByRole('button', { name })) }) }

it('opens the selected pending request first and retains an explicit Japanese response in the editor store', async () => {
  localStorage.setItem('dsh.mydot.editor.v1.coverage', JSON.stringify({ spaceId: null, editor: null }))
  const b = bench()
  const request = (id: string): HumanRequestView => ({ phase: 'pending', request: { requestId: id as HumanRequestId, requestRevision: 1,
    sessionId: parent, parentSessionId: null, question: `Question ${id}`, reason: 'Owner decision', role: 'owner', evidenceUrl: '',
    resumeInstruction: 'Continue the original Session', options: [], target: null, goal: null } })
  const answer = vi.fn(async () => {})
  b.source.set({ phase: 'ready', value: { ...b.snapshot, humanRequests: [request('first'), request('selected'), request('last')] } })
  render(<MyDotPanel {...b.panelProps} selectedHumanRequestId="selected" answerHumanRequest={answer}
    reconcileHumanRequest={vi.fn(async () => {})} cancelHumanRequest={vi.fn(async () => {})} />)
  const cards = screen.getAllByRole('article')
  expect(within(cards[0]!).getByRole('heading').textContent).toBe('Question selected')
  const selected = within(cards[0]!)
  fireEvent.change(selected.getByRole('combobox', { name: ja.humanResponse }), { target: { value: 'unknown' } })
  fireEvent.change(selected.getByRole('textbox', { name: ja.humanDetails }), { target: { value: '原図を再確認してください' } })
  await act(async () => { fireEvent.click(selected.getByRole('button', { name: ja.humanSubmit })) })
  expect(answer).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'selected', choice: 'unknown', text: '原図を再確認してください' }))
  expect(b.editor.getSnapshot().humanDrafts?.['selected:1']).toMatchObject({ choice: 'unknown', text: '原図を再確認してください', submissionId: 'request' })
  fireEvent.click(selected.getByRole('button', { name: ja.open }))
  expect(b.commands.openConversation).toHaveBeenCalledWith(parent)
})

it('names the targeted composer in the active locale and clears an accepted parent draft', async () => {
  const b = bench()
  b.snapshot.artifacts.push({ sessionId: parent, parentSessionId: child, path: '/own', available: true }, { sessionId: child, parentSessionId: child, path: '/unrelated', available: true })
  render(<MyDotDock {...b.dockProps} />)
  await click(ja.title)
  fireEvent.change(screen.getByRole('textbox', { name: ja.send }), { target: { value: 'Parent only' } })
  await click(ja.send)
  expect(b.commands.send).toHaveBeenCalledWith(parent, expect.objectContaining({ target: null, delivery: 'queue', text: 'Parent only' }))
  expect(screen.getByText(ja.accepted)).toBeTruthy()
})

it('shows loading, failure and disconnect retry without losing a vanished exact target', async () => {
  const b = bench()
  b.dock.actions.expand(true)
  b.source.set({ phase: 'loading' })
  render(<MyDotDock {...b.dockProps} />)
  expect(screen.getByRole('status').textContent).toBe(ja.loading)
  act(() => { b.source.set({ phase: 'failed', message: 'offline' }) })
  await click(ja.retry)
  expect(b.commands.retry).toHaveBeenCalledOnce()
  act(() => { b.source.set({ phase: 'ready', value: b.snapshot, disconnected: true })
    b.dock.actions.target('gone' as SessionId)
    b.dock.actions.text('Keep me') })
  expect(screen.getByRole('button', { name: ja.send }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByRole('combobox', { name: b.common.t('destination', { name: 'gone' }) }), { target: { value: '' } })
  fireEvent.change(screen.getByRole('combobox', { name: ja.method }), { target: { value: 'steer' } })
  fireEvent.change(screen.getByRole('combobox', { name: ja.method }), { target: { value: 'queue' } })
  await click(ja.details)
  await click('/report')
  expect(b.commands.open).toHaveBeenCalledWith(b.snapshot.jobs[0])
  expect(b.commands.preview).toHaveBeenCalledWith(b.snapshot.artifacts[0])
})

it('starts both named jobs and reports result-delivery and stop failures', async () => {
  const b = bench()
  b.dock.actions.expand(true)
  b.snapshot.issues = [{ sessionId: parent, kind: 'artifact-delivery' }, { sessionId: parent, kind: 'unavailable' }, { sessionId: child, kind: 'unavailable' }]
  b.commands.presentResults.mockRejectedValue(new Error('delivery'))
  b.commands.stop.mockRejectedValue(new Error('stop'))
  render(<MyDotDock {...b.dockProps} />)
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: ja.retry })[0]!) })
  expect(screen.getAllByText(ja.deliveryFailed).length).toBeGreaterThan(0)
  await click(ja.stop)
  expect(screen.getByText(/Error: stop/)).toBeTruthy()
  await click(ja.startJobs)
  for (const key of ['labelA', 'labelB', 'requestA', 'requestB'] as const) fireEvent.change(screen.getByLabelText(ja[key]), { target: { value: key } })
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: ja.startJobs }).at(-1)!) })
  expect(b.commands.startJob).toHaveBeenCalledTimes(2)
  expect(screen.queryByLabelText(ja.requestA)).toBeNull()
})

it('creates and archives Spaces, navigates exact conversations, and operates desktop ownership', async () => {
  const b = bench()
  render(<MyDotPanel {...b.panelProps} />)
  for (const [key, value] of [['name', 'New'], ['purpose', 'Purpose'], ['instructions', 'Instructions'], ['materials', ' /a \n\n /b '], ['workspace', 'workspace']] as const) fireEvent.change(screen.getByLabelText(ja[key]), { target: { value } })
  fireEvent.change(screen.getByLabelText(ja.workspace), { target: { value: '' } })
  await click(ja.create)
  expect(b.commands.saveSpace).toHaveBeenCalledWith(expect.objectContaining({ name: 'New', materials: ['/a', '/b'], workspaceId: undefined }))
  fireEvent.change(screen.getByLabelText(ja.spaces), { target: { value: spaceId } })
  await click(ja.save)
  await click(ja.archive)
  await click(ja.start)
  expect(b.commands.createConversation).toHaveBeenCalledWith(spaceId)
  await click('parent · /work')
  await click(ja.screen)
  await click(ja.release)
  await click(ja.handoff)
  expect(b.commands.releaseDesktop).toHaveBeenCalledWith(parent)
  act(() => { b.source.set({ phase: 'ready', value: { ...b.snapshot, desktop: { ...b.snapshot.desktop, phase: 'human' } } }) })
  await click(ja.resume)
  expect(b.commands.resume).toHaveBeenCalledWith(parent, 1000)
  await click(ja.scoped)
  expect(b.commands.readMemory).toHaveBeenCalledWith({ kind: 'space', spaceId })
})

it('renders Panel loading and disconnected failures and command errors', async () => {
  const b = bench()
  b.source.set({ phase: 'loading' })
  render(<MyDotPanel {...b.panelProps} />)
  expect(screen.getByRole('status').textContent).toBe(ja.loading)
  act(() => { b.source.set({ phase: 'failed', message: 'no source' }) })
  await click(ja.retry)
  act(() => { b.source.set({ phase: 'ready', value: { ...b.snapshot, desktopEnabled: false, desktop: { phase: 'free', inFlight: 0 } }, disconnected: true }) })
  expect(screen.getByText(ja.desktopDisabled)).toBeTruthy()
  b.commands.saveSpace.mockRejectedValue(new Error('save space'))
  fireEvent.change(screen.getByLabelText(ja.name), { target: { value: 'Fail' } })
  await click(ja.create)
  expect(screen.getByText(/Error: save space/)).toBeTruthy()
  b.commands.readMemory.mockRejectedValue(new Error('read memory'))
  await click(ja.personal)
  expect(screen.getByText(/Error: read memory/)).toBeTruthy()
})

it('edits an artifact, rejects closing a dirty draft, discards, saves, reloads and continues exact versions', async () => {
  const b = bench()
  render(<MyDotPanel {...b.panelProps} />)
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: ja.edit })[0]!) })
  const editor = () => within(screen.getByRole('region', { name: ja.edit }))
  fireEvent.change(editor().getByRole('textbox'), { target: { value: 'Draft' } })
  await click(ja.close)
  expect(screen.getByText(/Save or discard/)).toBeTruthy()
  await click(ja.discard)
  await click(ja.reload)
  await click(ja.continue)
  expect(b.commands.continueFile).toHaveBeenCalledWith(parent, '/report', 'v1')
  fireEvent.change(editor().getByRole('textbox'), { target: { value: 'Saved' } })
  await act(async () => { fireEvent.click(editor().getByRole('button', { name: ja.save })) })
  expect(b.commands.saveFile).toHaveBeenCalledWith(parent, { path: '/report', version: 'v1', content: 'Saved' })
  await click(ja.close)
  expect(screen.queryByRole('region', { name: ja.edit })).toBeNull()
})

it('keeps store guards valid after an editor closes and rejects replacing a dirty document', () => {
  const b = bench()
  const a = b.editor.actions
  a.draft('ignored')
  a.discard()
  a.saved(FsVersion('ignored'), 'ignored')
  a.conflict(null, 'ignored')
  a.close()
  a.open({ sessionId: parent, scope: null, path: '/report', version: null, saved: '', draft: 'unsaved', conflict: null })
  expect(() =>{  a.open({ sessionId: parent, scope: null, path: '/other', version: null, saved: '', draft: '', conflict: null }) }).toThrow('Save or discard')
  a.discard()
  a.open({ sessionId: parent, scope: null, path: '/other', version: null, saved: '', draft: '', conflict: null })
  a.close()
  expect(b.editor.getSnapshot().editor).toBeNull()
})

it('retains a missing-file conflict, reports failed saves and reloads, and reloads personal memory', async () => {
  const b = bench()
  const readMemory = vi.fn<Commands['readMemory']>().mockResolvedValue({ kind: 'missing', path: '/memory' })
  const readFile = vi.fn<Commands['readFile']>().mockResolvedValue({ kind: 'missing', path: '/report' })
  const saveFile = vi.fn<Commands['saveFile']>().mockResolvedValueOnce({ kind: 'conflict', path: '/report', draft: 'Draft', current: { kind: 'missing', path: '/report' } }).mockRejectedValue(new Error('write failed'))
  const continueFile = vi.fn<Commands['continueFile']>().mockRejectedValue(new Error('continue failed'))
  render(<MyDotPanel {...b.panelProps} readMemory={readMemory} readFile={readFile} saveFile={saveFile} continueFile={continueFile} />)
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: ja.edit })[0]!) })
  const editor = () => within(screen.getByRole('region', { name: ja.edit }))
  fireEvent.change(editor().getByRole('textbox'), { target: { value: 'Draft' } })
  await act(async () => { fireEvent.click(editor().getByRole('button', { name: ja.save })) })
  expect(editor().getByText(ja.conflict)).toBeTruthy()
  expect(editor().getByRole<HTMLTextAreaElement>('textbox').value).toBe('Draft')
  await act(async () => { fireEvent.click(editor().getByRole('button', { name: ja.save })) })
  expect(editor().getByText(/write failed/)).toBeTruthy()
  await click(ja.discard)
  await click(ja.reload)
  expect(editor().getAllByText(new RegExp(ja.missing))).toHaveLength(2)
  await click(ja.close)
  await click(ja.personal)
  await click(ja.reload)
  expect(readMemory).toHaveBeenCalledTimes(2)
  await click(ja.close)
  act(() => { b.editor.actions.open({ sessionId: parent, scope: null, path: '/report', version: FsVersion('v1'), saved: '', draft: '', conflict: null }) })
  await click(ja.continue)
  expect(editor().getByText(/continue failed/)).toBeTruthy()
})

it('previews and opens source artifacts and handles archived Space and stopping desktop views', async () => {
  const b = bench()
  b.snapshot.jobs.push({ parentSessionId: parent, childSessionId: 'inactive' as SessionId, label: 'Finished', mode: 'one-shot', status: 'inactive' })
  b.snapshot.spaces[0]!.archived = true
  b.snapshot.desktop = { phase: 'stopping', owner: parent, inFlight: 1 }
  render(<MyDotPanel {...b.panelProps} />)
  const articles = screen.getAllByRole('article')
  await act(async () => { fireEvent.click(within(articles[0]!).getByRole('button', { name: ja.open })) })
  const file = articles.find(article => within(article).queryByText('/report') !== null)!
  await act(async () => { fireEvent.click(within(file).getByRole('button', { name: ja.open }))
    fireEvent.click(within(file).getByRole('button', { name: ja.preview })) })
  expect(b.commands.openConversation).toHaveBeenCalledWith(parent)
  expect(b.commands.preview).toHaveBeenCalledWith(b.snapshot.artifacts[0])
  fireEvent.change(screen.getByLabelText(ja.spaces), { target: { value: spaceId } })
  expect(screen.getByRole('button', { name: ja.archive }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText(ja.spaces), { target: { value: '' } })
  expect(screen.getByRole('button', { name: ja.create })).toBeTruthy()
})

it('reports archive failures without changing the selected Space', async () => {
  const b = bench()
  b.editor.actions.select(spaceId)
  b.commands.saveSpace.mockRejectedValue(new Error('archive failed'))
  render(<MyDotPanel {...b.panelProps} />)
  await click(ja.archive)
  expect(screen.getByText(/archive failed/)).toBeTruthy()
  expect(b.editor.getSnapshot().spaceId).toBe(spaceId)
})
import type { FilingView } from '../src/filing-types.ts'

const panelFiling: FilingView = {
  sessionId: child, revision: 3, planDigest: 'a'.repeat(64), actor: 'model-preparer', control: 'agent', phase: 'prepared',
  plan: { caseId: 'panel-review' as FilingView['plan']['caseId'], legalEntity: 'Panel Entity', account: 'mock-account',
    site: 'local-synthetic-recipient', destination: 'mock-local', period: { from: '2025-01-01', to: '2025-12-31' },
    tax: 'mock-tax', amount: '1000', currency: 'JPY', forms: ['return'], expiresAt: 2000000000000,
    files: [{ role: 'source', path: 'source.txt', digest: 'b'.repeat(64) }, { role: 'preview', path: 'preview.txt', digest: 'c'.repeat(64) }],
    inputDestinations: ['local-preview'], modelDestinations: [], stopRef: 'cancel', queryRef: 'query',
    effects: { submit: true, payment: 'none', standingSettings: 'none' } },
}

it('opens filing source and preview text in the existing editor using their original Session', async () => {
  const b = bench()
  b.source.set({ phase: 'ready', value: { ...b.snapshot, filings: [{ filing: panelFiling, confirmationReady: false }] } })
  const readFile = vi.fn<Commands['readFile']>().mockImplementation(async (_sessionId, path) => ({
    kind: 'text', path: `/current/${path}`, content: `Read ${path}`, version: FsVersion('filing-v1'),
  }))
  const filingCommand = vi.fn<NonNullable<Commands['filingCommand']>>().mockResolvedValue(undefined)
  render(<MyDotPanel {...b.panelProps} readFile={readFile} filingCommand={filingCommand} />)
  const card = within(screen.getByRole('heading', { name: `${ja.filingTitle} · ${panelFiling.plan.caseId}` }).closest('article')!)
  expect(readFile).not.toHaveBeenCalled()
  expect(filingCommand).not.toHaveBeenCalled()
  fireEvent.click(card.getByRole('button', { name: ja.open }))
  expect(b.commands.openConversation).toHaveBeenCalledWith(child)
  for (const file of panelFiling.plan.files) {
    await act(async () => { fireEvent.click(card.getByRole('button', { name: `${ja.filingOpenFile} ${file.path}` })) })
    expect(readFile).toHaveBeenLastCalledWith(child, file.path)
    expect(b.editor.getSnapshot().editor).toEqual({
      sessionId: child, scope: null, path: `/current/${file.path}`, version: FsVersion('filing-v1'),
      saved: `Read ${file.path}`, draft: `Read ${file.path}`, conflict: null,
    })
    const editor = within(screen.getByRole('region', { name: ja.edit }))
    expect(editor.getByRole<HTMLTextAreaElement>('textbox', { name: ja.edit }).value).toBe(`Read ${file.path}`)
    expect(editor.getByText(`/current/${file.path}`)).toBeTruthy()
  }
  expect(readFile.mock.calls).toEqual(panelFiling.plan.files.map(file => [child, file.path]))
  expect(b.commands.preview).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(card.getByRole('button', { name: ja.filingApprove })) })
  expect(filingCommand).toHaveBeenCalledExactlyOnceWith('approve', panelFiling)
})

it.each(['missing', 'rejected'] as const)('reports a %s filing read while retaining the open document', async (kind) => {
  const b = bench()
  const existing = { sessionId: parent, scope: null, path: '/retained', version: FsVersion('retained-v1'),
    saved: 'Retained document', draft: 'Retained document', conflict: null }
  b.editor.actions.open(existing)
  b.source.set({ phase: 'ready', value: { ...b.snapshot, filings: [{ filing: panelFiling, confirmationReady: false }] } })
  const readFile = vi.fn<Commands['readFile']>()
  const file = panelFiling.plan.files[kind === 'missing' ? 0 : 1]!
  const failure = new Error(kind === 'missing' ? ja.missing : 'filing read offline')
  if (kind === 'missing') readFile.mockResolvedValue({ kind: 'missing', path: file.path })
  else readFile.mockRejectedValue(failure)
  render(<MyDotPanel {...b.panelProps} readFile={readFile} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: `${ja.filingOpenFile} ${file.path}` })) })
  expect(readFile).toHaveBeenCalledExactlyOnceWith(child, file.path)
  expect(screen.getByRole('alert').textContent).toBe(b.common.t('error', { message: String(failure) }))
  expect(b.editor.getSnapshot().editor).toEqual(existing)
  expect(within(screen.getByRole('region', { name: ja.edit })).getByRole<HTMLTextAreaElement>('textbox').value)
    .toBe('Retained document')
  expect(b.commands.openConversation).not.toHaveBeenCalled()
  expect(b.commands.preview).not.toHaveBeenCalled()
})
