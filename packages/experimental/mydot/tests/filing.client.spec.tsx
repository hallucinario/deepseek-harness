// @vitest-environment jsdom
/** Owner-only buttons expose intent readiness, uncertain recovery and evidence separately. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FilingCard } from '../src/client/Filing.tsx'
import { en } from '../src/client/locales.ts'
import type { FilingView, FilingCaseId } from '../src/filing-types.ts'
afterEach(cleanup)
const filing: FilingView = { sessionId: SessionId('owner-session'), revision: 1, planDigest: 'a'.repeat(64), actor: 'host-owner', control: 'human', phase: 'intent', intentId: 'stable-intent',
  plan: { caseId: 'case-27' as FilingCaseId, legalEntity: 'Mock Entity', account: 'mock-account', site: 'local-synthetic-recipient',
    period: { from: '2025-01-01', to: '2025-12-31' }, tax: 'mock-tax', destination: 'mock-local', amount: '1000', currency: 'JPY', forms: ['return'],
    files: [{ role: 'source', path: 'source.txt', digest: 'b'.repeat(64) }, { role: 'preview', path: 'preview.txt', digest: 'c'.repeat(64) }],
    inputDestinations: ['local-preview'], modelDestinations: [], expiresAt: 2000000000000, stopRef: 'cancel', queryRef: 'query',
    effects: { submit: true, payment: 'none', standingSettings: 'none' } } }
it('keeps confirm disabled without live durable readiness and requires an explicit owner click', async () => {
  const command = vi.fn().mockResolvedValue(undefined)
  const props = { card: { filing, confirmationReady: false }, command, open: vi.fn(), t: makeTranslate(en) }
  const view = render(<FilingCard {...props} />)
  expect(command).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.filingConfirm }).disabled).toBe(true)
  view.rerender(<FilingCard {...props} card={{ filing, confirmationReady: true }} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.filingConfirm })) })
  expect(command).toHaveBeenCalledWith('confirmMock', filing)
})
it('offers query after uncertainty and shows accepted with partial recording separately', () => {
  const props = { card: { filing: { ...filing, phase: 'unknown' as const }, confirmationReady: false }, command: vi.fn(), open: vi.fn(), t: makeTranslate(en) }
  const view = render(<FilingCard {...props} />)
  expect(screen.queryByRole('button', { name: en.filingConfirm })).toBeNull()
  expect(screen.getByRole('button', { name: en.filingQuery })).toBeTruthy()
  view.rerender(<FilingCard {...props} card={{ confirmationReady: false, filing: { ...filing, phase: 'accepted',
    receipt: { receiptId: 'receipt-1', intentId: 'stable-intent', caseId: filing.plan.caseId, planDigest: filing.planDigest, forms: ['return'] },
    recorder: { version: 'high-impact-recorder/v1', caseId: filing.plan.caseId, planDigest: filing.planDigest, state: 'recording', evidence: 'partial',
      readyForConfirmation: true, sequence: 1, observedAt: 1000, archiveRef: 'archive-1', segments: ['segment-1'], gaps: ['gap-1'], protectedIntervals: [],
    } } }} />)
  expect(screen.getByText(/receipt-1/)).toBeTruthy(); expect(screen.getByText(/gap-1/)).toBeTruthy()
  expect(screen.getByText(en.filingAccepted)).toBeTruthy()
})
it('requires a fresh owner confirmation of other controllers for each displayed revision', async () => {
  const command = vi.fn().mockResolvedValue(undefined)
  const approved: FilingView = { ...filing, phase: 'approved' }
  const props = { card: { filing: approved, confirmationReady: false }, command, open: vi.fn(), t: makeTranslate(en) }
  const view = render(<FilingCard {...props} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.filingBegin }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.filingBegin })) })
  expect(command).toHaveBeenCalledWith('begin', approved, true)
  view.rerender(<FilingCard {...props} card={{ ...props.card, filing: { ...approved, revision: 2, planDigest: 'b'.repeat(64) } }} />)
  expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.filingBegin }).disabled).toBe(true)
})

it.each([
  ['prepared', false, en.filingPrepared, en.filingApprove],
  ['approved', false, en.filingApproved, en.filingBegin],
  ['intent', false, en.filingIntent, en.filingResume],
  ['intent', true, en.filingIntent, en.filingConfirm],
  ['unknown', false, en.filingUnknown, en.filingQuery],
  ['accepted', false, en.filingAccepted, en.filingReturn],
  ['cancelled', false, en.filingCancelled, en.filingReturn],
  ['invalidated', false, en.filingInvalidated, en.filingReturn],
] as const)('shows %s with readiness %s while unavailable commands remain disabled', (phase, confirmationReady, status, primary) => {
  const current: FilingView = { ...filing, phase, intentId: phase === 'prepared' ? undefined : filing.intentId }
  const open = vi.fn()
  render(<FilingCard card={{ filing: current, confirmationReady }} open={open} t={makeTranslate(en)} />)
  expect(screen.getByRole('status').textContent).toBe(status)
  const checkbox = screen.queryByRole<HTMLInputElement>('checkbox')
  if (checkbox !== null) fireEvent.click(checkbox)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: primary }).disabled).toBe(true)
  for (const label of [en.filingApprove, en.filingBegin, en.filingResume, en.filingConfirm,
    en.filingQuery, en.humanCancel, en.filingReturn]) {
    const button = screen.queryByRole<HTMLButtonElement>('button', { name: label })
    if (button !== null) expect(button.disabled).toBe(true)
  }
  for (const file of current.plan.files) {
    expect(screen.getByRole<HTMLButtonElement>('button', { name: `${en.filingOpenFile} ${file.path}` }).disabled).toBe(true)
  }
  fireEvent.click(screen.getByRole('button', { name: en.open }))
  expect(open).toHaveBeenCalledOnce()
})

it.each([
  ['prepared', false, en.filingApprove, 'approve'],
  ['prepared', false, en.humanCancel, 'cancel'],
  ['approved', false, en.filingBegin, 'begin'],
  ['intent', false, en.filingResume, 'begin'],
  ['intent', true, en.filingConfirm, 'confirmMock'],
  ['unknown', false, en.filingQuery, 'reconcile'],
  ['accepted', false, en.filingReturn, 'returnControl'],
  ['cancelled', false, en.filingReturn, 'returnControl'],
  ['invalidated', false, en.filingReturn, 'returnControl'],
] as const)('dispatches the explicit %s action %s %s as %s', async (phase, confirmationReady, label, action) => {
  const current: FilingView = { ...filing, phase, control: phase === 'cancelled' ? 'stopping' : 'human',
    intentId: phase === 'prepared' ? undefined : filing.intentId }
  const command = vi.fn().mockResolvedValue(undefined)
  render(<FilingCard card={{ filing: current, confirmationReady }} command={command} open={vi.fn()} t={makeTranslate(en)} />)
  expect(command).not.toHaveBeenCalled()
  const button = screen.getByRole<HTMLButtonElement>('button', { name: label })
  if (action === 'begin') {
    expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en.filingControlsClosed }))
  }
  expect(button.disabled).toBe(false)
  await act(async () => { fireEvent.click(button) })
  expect(command).toHaveBeenCalledOnce()
  if (action === 'begin') expect(command).toHaveBeenCalledWith(action, current, true)
  else expect(command).toHaveBeenCalledWith(action, current)
})

it.each([
  ['revision', { revision: filing.revision + 1 }],
  ['digest', { planDigest: 'd'.repeat(64) }],
] as const)('requires a new checkbox assertion when only the %s changes', (_field, change) => {
  const current: FilingView = { ...filing, phase: 'approved', ownerControlConfirmation: {
    revision: filing.revision, planDigest: filing.planDigest, confirmedAt: 1000, source: 'host-owner',
  } }
  const command = vi.fn().mockResolvedValue(undefined)
  const props = { card: { filing: current, confirmationReady: false }, command, open: vi.fn(), t: makeTranslate(en) }
  const view = render(<FilingCard {...props} />)
  const checkbox = () => screen.getByRole<HTMLInputElement>('checkbox', { name: en.filingControlsClosed })
  const begin = () => screen.getByRole<HTMLButtonElement>('button', { name: en.filingBegin })
  expect(checkbox().checked).toBe(false)
  expect(begin().disabled).toBe(true)
  fireEvent.click(checkbox())
  expect(begin().disabled).toBe(false)
  fireEvent.click(checkbox())
  expect(checkbox().checked).toBe(false)
  expect(begin().disabled).toBe(true)
  fireEvent.click(checkbox())
  view.rerender(<FilingCard {...props} card={{ filing: { ...current, ...change }, confirmationReady: false }} />)
  expect(checkbox().checked).toBe(false)
  expect(begin().disabled).toBe(true)
  fireEvent.click(checkbox())
  expect(begin().disabled).toBe(false)
  expect(command).not.toHaveBeenCalled()
})

it('admits only one confirmation during a reentrant click and restores controls after settlement', async () => {
  const deferred = Promise.withResolvers<undefined>()
  const command = vi.fn<NonNullable<Parameters<typeof FilingCard>[0]['command']>>().mockResolvedValue(undefined)
  render(<FilingCard card={{ filing, confirmationReady: true }} command={command} open={vi.fn()} t={makeTranslate(en)} />)
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: en.filingConfirm })
  command.mockImplementationOnce(() => {
    fireEvent.click(confirm)
    return deferred.promise
  })
  try {
    await act(async () => { fireEvent.click(confirm) })
    expect(command).toHaveBeenCalledOnce()
    expect(command).toHaveBeenCalledWith('confirmMock', filing)
    expect(confirm.disabled).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox').disabled).toBe(true)
    for (const label of [en.filingQuery, en.humanCancel]) {
      const button = screen.getByRole<HTMLButtonElement>('button', { name: label })
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }
    fireEvent.click(confirm)
    expect(command).toHaveBeenCalledOnce()
  } finally {
    await act(async () => { deferred.resolve(undefined); await deferred.promise })
  }
  expect(confirm.disabled).toBe(false)
  expect(screen.getByRole<HTMLInputElement>('checkbox').disabled).toBe(false)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.filingQuery }).disabled).toBe(false)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([
  ['approved', false, en.filingBegin, 'begin'],
  ['intent', true, en.filingConfirm, 'confirmMock'],
] as const)('queries the existing intent after an uncertain %s %s %s operation %s', async (phase, confirmationReady, label, action) => {
  const current: FilingView = { ...filing, phase }
  const deferred = Promise.withResolvers<undefined>()
  const command = vi.fn().mockReturnValueOnce(deferred.promise).mockResolvedValue(undefined)
  const props = { command, open: vi.fn(), t: makeTranslate(en) }
  const view = render(<FilingCard {...props} card={{ filing: current, confirmationReady }} />)
  try {
    if (action === 'begin') fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.filingQuery }).disabled).toBe(true)
    await act(async () => {
      deferred.reject(new Error('owner reply lost'))
      await deferred.promise.catch((error: unknown) => { expect(error).toBeInstanceOf(Error) })
    })
    expect(screen.getByRole('alert').textContent).toBe(makeTranslate(en)('error', { message: 'Error: owner reply lost' }))
    if (action === 'begin') expect(screen.getByRole<HTMLButtonElement>('button', { name: en.filingBegin }).disabled).toBe(true)
    else expect(screen.queryByRole('button', { name: en.filingConfirm })).toBeNull()
    const recovered: FilingView = { ...current, phase: 'intent' }
    view.rerender(<FilingCard {...props} card={{ filing: recovered, confirmationReady: true }} />)
    expect(command).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: en.filingConfirm })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.filingQuery })) })
    expect(command).toHaveBeenCalledTimes(2)
    expect(command).toHaveBeenLastCalledWith('reconcile', recovered)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: en.filingConfirm })).toBeNull()
  } finally {
    await act(async () => {
      deferred.resolve(undefined)
      await deferred.promise.catch((error: unknown) => { expect(error).toBeInstanceOf(Error) })
    })
  }
})

it('allows approval retry after rejection without marking a later begin uncertain', async () => {
  const current: FilingView = { ...filing, phase: 'prepared', intentId: undefined }
  const command = vi.fn().mockRejectedValueOnce(new Error('approval refused')).mockResolvedValue(undefined)
  const props = { command, open: vi.fn(), t: makeTranslate(en) }
  const view = render(<FilingCard {...props} card={{ filing: current, confirmationReady: false }} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.filingApprove })) })
  expect(screen.getByRole('alert').textContent).toContain('approval refused')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.filingApprove }).disabled).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.filingApprove })) })
  expect(command.mock.calls).toEqual([['approve', current], ['approve', current]])
  expect(screen.queryByRole('alert')).toBeNull()
  view.rerender(<FilingCard {...props} card={{ filing: { ...current, phase: 'approved' }, confirmationReady: false }} />)
  fireEvent.click(screen.getByRole('checkbox'))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.filingBegin }).disabled).toBe(false)
  expect(command).toHaveBeenCalledTimes(2)
})

it('shows only changed plan fields, separate effects and an authorized control return', () => {
  const current: FilingView = { ...filing, phase: 'invalidated', actor: 'model-preparer', control: 'return-authorized',
    reason: 'files-changed', previousPlan: filing.plan,
    plan: { ...filing.plan, amount: '1250', forms: ['return', 'schedule'],
      effects: { submit: false, payment: 'one-time', standingSettings: 'auto-debit' } } }
  const command = vi.fn().mockResolvedValue(undefined)
  render(<FilingCard card={{ filing: current, confirmationReady: false }} command={command} open={vi.fn()} t={makeTranslate(en)} />)
  const comparison = screen.getByText(en.filingDiff).closest('details')!
  fireEvent.click(screen.getByText(en.filingDiff))
  expect(comparison.querySelectorAll('p')).toHaveLength(3)
  expect(comparison.textContent).toContain('amount: "1000" → "1250"')
  expect(comparison.textContent).toContain('forms: ["return"] → ["return","schedule"]')
  expect(comparison.textContent).toContain('effects:')
  expect(comparison.textContent).not.toContain('legalEntity:')
  expect(screen.getByText(/Model preparer/)).toBeTruthy()
  expect(screen.getByText(`${en.filingReason}: files-changed`)).toBeTruthy()
  expect(screen.getByText(content => content.includes(en.filingOneTime) && content.includes(en.filingAutoDebit)).textContent)
    .toContain(`${en.filingSubmit} ${en.filingNo}`)
  expect(screen.getByText(`${en.filingReceipt}: ${en.filingNoReceipt}`)).toBeTruthy()
  expect(screen.getByText(en.filingReturnAuthorized)).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.filingReturn }).disabled).toBe(false)
  expect(command).not.toHaveBeenCalled()
})

it.each([
  [undefined, en.filingUnavailable],
  ['complete', en.filingComplete],
  ['partial', en.filingPartial],
  ['unavailable', en.filingUnavailable],
] as const)('keeps a verified receipt independent of recording evidence %s', (evidence, label) => {
  const recorder: FilingView['recorder'] = evidence === undefined ? undefined : {
    version: 'high-impact-recorder/v1', caseId: filing.plan.caseId, planDigest: filing.planDigest,
    state: evidence === 'unavailable' ? 'failed' : 'recording', evidence, readyForConfirmation: evidence === 'complete',
    sequence: 2, observedAt: 1000, archiveRef: 'archive-ui', segments: ['segment-ui'],
    gaps: evidence === 'complete' ? [] : ['gap-ui'], protectedIntervals: ['protected-ui'],
  }
  const current: FilingView = { ...filing, phase: 'accepted', recorder,
    receipt: { receiptId: 'receipt-ui', intentId: filing.intentId!, caseId: filing.plan.caseId, planDigest: filing.planDigest, forms: filing.plan.forms } }
  const command = vi.fn().mockResolvedValue(undefined)
  render(<FilingCard card={{ filing: current, confirmationReady: false }} command={command} open={vi.fn()} t={makeTranslate(en)} />)
  expect(screen.getByRole('status').textContent).toBe(en.filingAccepted)
  expect(screen.getByText(`${en.filingReceipt}: receipt-ui`)).toBeTruthy()
  expect(screen.getByText(`${en.filingRecording}: ${label}`)).toBeTruthy()
  if (recorder === undefined) expect(screen.queryByText(/archive-ui/)).toBeNull()
  else {
    const recording = screen.getByText(/archive-ui/)
    expect(recording.textContent).toContain('segment-ui')
    expect(recording.textContent).toContain('protected-ui')
    if (evidence !== 'complete') expect(recording.textContent).toContain('gap-ui')
  }
  expect(screen.queryByRole('button', { name: en.filingConfirm })).toBeNull()
  expect(command).not.toHaveBeenCalled()
})

it('opens each reviewed source or preview through its path callback and opens the original conversation separately', () => {
  const openFile = vi.fn()
  const open = vi.fn()
  const command = vi.fn().mockResolvedValue(undefined)
  render(<FilingCard card={{ filing, confirmationReady: false }} command={command} open={open} openFile={openFile} t={makeTranslate(en)} />)
  for (const file of filing.plan.files) {
    fireEvent.click(screen.getByRole('button', { name: `${en.filingOpenFile} ${file.path}` }))
    expect(openFile).toHaveBeenLastCalledWith(file.path)
    expect(screen.getByText(file.digest)).toBeTruthy()
  }
  expect(openFile.mock.calls).toEqual(filing.plan.files.map(file => [file.path]))
  expect(open).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.open }))
  expect(open).toHaveBeenCalledOnce()
  expect(command).not.toHaveBeenCalled()
})

it('does not offer another control return after control already belongs to the agent', () => {
  const command = vi.fn().mockResolvedValue(undefined)
  render(<FilingCard card={{ filing: { ...filing, phase: 'accepted', control: 'agent' }, confirmationReady: false }}
    command={command} open={vi.fn()} t={makeTranslate(en)} />)
  expect(screen.queryByRole('button', { name: en.filingReturn })).toBeNull()
  expect(screen.queryByText(en.filingReturnAuthorized)).toBeNull()
  expect(command).not.toHaveBeenCalled()
})
