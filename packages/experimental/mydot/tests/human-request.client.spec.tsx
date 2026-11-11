// @vitest-environment jsdom
/** Mobile response cards preserve drafts and distinguish admission from execution. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HumanRequestCard } from '../src/client/HumanRequest.tsx'
import { createEditorStore } from '../src/client/editor-store.ts'
import { ja } from '../src/client/locales.ts'
import type { HumanRequestId, PreparedHumanRequest, HumanRequestView } from '../src/types.ts'

afterEach(() => { cleanup(); localStorage.clear() })
const request: PreparedHumanRequest = { requestId: 'owner-review' as HumanRequestId, requestRevision: 1, sessionId: SessionId('origin'), parentSessionId: null,
  question: '図面を確認してください', reason: '独立した原図確認が必要です', role: 'owner', evidenceUrl: 'https://example.test/survey?requestId=owner-review',
  resumeInstruction: '保存した版から再評価します', options: ['選択肢'], target: null, goal: null }

it('adds a response draft to a persisted editor value created before human requests existed', () => {
  const editor = { path: '/report', version: null, saved: 'saved', draft: 'unsaved text', conflict: null, sessionId: 'origin', scope: null }
  localStorage.setItem('dsh.mydot.editor.v1.legacy', JSON.stringify({ spaceId: null, editor }))
  const store = createEditorStore().create('legacy')
  store.actions.humanDraft('owner-review:1', { choice: 'unknown', text: '資料が必要です', submissionId: '' })
  expect(store.getSnapshot()).toMatchObject({ editor, humanDrafts: { 'owner-review:1': { choice: 'unknown', text: '資料が必要です' } } })
})

it('retains Japanese text and one submission identity after an uncertain send and remount', async () => {
  const store = createEditorStore().create('human-response')
  store.actions.humanDraft('owner-review:1', { choice: 'confirmed', text: '日本語の訂正', submissionId: '' })
  const answer = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(undefined)
  const mint = vi.fn(() => 'stable-submission')
  const props = () => ({ view: { request, phase: 'pending' } satisfies HumanRequestView,
    draft: store.getSnapshot().humanDrafts!['owner-review:1']!,
    change: (draft: { choice: string; text: string; submissionId: string }) => { store.actions.humanDraft('owner-review:1', draft) },
    answer, reconcile: vi.fn(), cancel: vi.fn(), mint, selected: true, open: vi.fn(), t: makeTranslate(ja) })
  const first = render(<HumanRequestCard {...props()} />)
  expect(answer).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: ja.humanSubmit })) })
  expect(screen.getByRole('alert').textContent).toContain('connection lost')
  expect(store.getSnapshot().humanDrafts?.['owner-review:1']).toEqual({ choice: 'confirmed', text: '日本語の訂正', submissionId: 'stable-submission' })
  first.unmount()
  render(<HumanRequestCard {...props()} />)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: ja.humanDetails }).value).toBe('日本語の訂正')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: ja.humanSubmit })) })
  expect(answer.mock.calls[0]?.[0]).toEqual(answer.mock.calls[1]?.[0])
  expect(mint).toHaveBeenCalledOnce()
})

it('shows saved, queued, consumed, stopped and recorded result as distinct states', () => {
  const props = { draft: { choice: '', text: '', submissionId: '' }, change: vi.fn(), mint: vi.fn(), selected: false, open: vi.fn(), t: makeTranslate(ja) }
  const page = render(<HumanRequestCard {...props} view={{ request, phase: 'received' }} />)
  expect(screen.getByRole('status').textContent).toBe(ja.humanReceived)
  page.rerender(<HumanRequestCard {...props} view={{ request, phase: 'queued' }} />)
  expect(screen.getByRole('status').textContent).toBe(ja.humanQueued)
  page.rerender(<HumanRequestCard {...props} view={{ request, phase: 'resumed' }} />)
  expect(screen.getByRole('status').textContent).toBe(ja.humanResumed)
  page.rerender(<HumanRequestCard {...props} view={{ request, phase: 'stopped', reason: '対象版が変わりました' }} />)
  expect(screen.getByText('対象版が変わりました')).toBeTruthy()
  page.rerender(<HumanRequestCard {...props} view={{ request, phase: 'outcome', outcome: 'failed', evidence: '品質確認待ち' }} />)
  expect(screen.getByRole('status').textContent).toBe(ja.humanOutcome)
  expect(screen.getByText('failed: 品質確認待ち')).toBeTruthy()
  page.rerender(<HumanRequestCard {...props} view={{ request, phase: 'retired' }} />)
  expect(screen.getByRole('status').textContent).toBe(ja.humanRetired)
  page.rerender(<HumanRequestCard {...props} view={{ request: { ...request, evidenceUrl: '' }, phase: 'claimed', answer: { requestId: request.requestId,
    requestRevision: 1, submissionId: 'done' as never, choice: 'confirmed', text: '保存済み', result: null } }} />)
  expect(screen.getByText(/保存済み/)).toBeTruthy()
})

it('opens the source without answering and keeps model options out of independent reference', async () => {
  const survey = { ...request, options: ['モデル候補123'], target: {
    caseId: 'public-case', sourceId: 'source', sourceRevision: 'a'.repeat(64),
    baseRevisionId: 'b'.repeat(64), baseVersion: 1, workflow: 'independent-reference' as const } }
  const open = vi.fn()
  const answer = vi.fn()
  const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'))
  const reconcile = vi.fn().mockRejectedValue(new Error('stale source'))
  const change = vi.fn()
  render(<HumanRequestCard view={{ request: survey, phase: 'pending' }} draft={{ choice: '', text: '', submissionId: 'old' }}
    change={change} answer={answer} reconcile={reconcile} cancel={cancel} mint={vi.fn()}
    selected={false} open={open} t={makeTranslate(ja)} />)
  expect(screen.queryByText('モデル候補123')).toBeNull()
  expect(screen.getByRole('link', { name: ja.humanEvidence }).getAttribute('href')).toContain('requestId=owner-review')
  fireEvent.change(screen.getByRole('combobox', { name: ja.humanResponse }), { target: { value: 'deferred' } })
  expect(change).toHaveBeenCalledWith({ choice: 'deferred', text: '', submissionId: '' })
  fireEvent.change(screen.getByRole('textbox', { name: ja.humanDetails }), { target: { value: '追加資料待ち' } })
  expect(change).toHaveBeenCalledWith({ choice: '', text: '追加資料待ち', submissionId: '' })
  fireEvent.click(screen.getByRole('button', { name: ja.open }))
  expect(open).toHaveBeenCalledOnce()
  expect(answer).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: ja.humanRefresh })) })
  expect(screen.getByRole('alert').textContent).toContain('stale source')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: ja.humanCancel })) })
  expect(screen.getByRole('alert').textContent).toContain('cancel failed')
})
