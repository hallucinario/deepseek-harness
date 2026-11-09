// @vitest-environment jsdom
/** Exact request/commit bindings and existing CI observations stay separate from execution. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { VerificationCheck, VerificationCheckId, VerificationTarget, VerificationView } from '../src/types.ts'
import { MyDotVerification } from '../src/client/Verification.tsx'
import { en, ja, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const child = 'child-a' as SessionId
const commit = 'a'.repeat(40)
const check: VerificationCheck = { id: 'dot-files-lint' as VerificationCheckId, repository: 'hallucinario/dot-files',
  workflowPath: '.github/workflows/ci.yml', workflowFileSha: 'b'.repeat(40), jobName: 'Lint (Static)', description: 'Lint only' }
const request = { seq: SessionSeq(2), text: 'Update the managed settings.' }
const target: VerificationTarget = { seq: SessionSeq(8), request, commit, check, checkRevision: 'c'.repeat(64) }
const view: VerificationView = { requests: [request, { seq: SessionSeq(5), text: 'A separate request.' }], target: null,
  status: 'unobserved', definitionCurrent: true, history: [], invalidRecords: false }

function setup(value = view) {
  return { sessionId: child, verification: value, checks: [check], disabled: false, t: makeTranslate(ja),
    openConversation: vi.fn(), setVerificationTarget: vi.fn(async () => {}), refreshVerification: vi.fn(async () => {}) }
}

function expand() { fireEvent.click(screen.getByRole('button', { name: ja.verificationDetails })) }
async function click(label: string) { await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) }) }

it('binds the selected user message and full commit without accepting a caller conclusion', async () => {
  const props = setup()
  const alternate = { ...check, id: 'dot-files-typecheck' as VerificationCheckId, jobName: 'Typecheck' }
  props.checks.push(alternate)
  render(<MyDotVerification {...props} />)
  expect(screen.getByText(ja.verificationUnobserved)).toBeTruthy()
  expect(props.refreshVerification).not.toHaveBeenCalled()
  expand()
  fireEvent.change(screen.getByLabelText(ja.verificationRequest), { target: { value: '5' } })
  fireEvent.change(screen.getByLabelText(ja.verificationCondition), { target: { value: alternate.id } })
  fireEvent.change(screen.getByLabelText(ja.verificationCommit), { target: { value: commit } })
  await click(ja.verificationSetTarget)
  expect(props.setVerificationTarget).toHaveBeenCalledExactlyOnceWith(child, { requestSeq: 5, checkId: alternate.id, commit })
  expect(props.refreshVerification).not.toHaveBeenCalled()
  expect(screen.getByText(ja.verificationUnobserved)).toBeTruthy()
})

it('retains the selected input and a localized failure after an unsuccessful binding', async () => {
  const props = setup()
  props.setVerificationTarget.mockRejectedValue(new Error('private backend diagnostic'))
  render(<MyDotVerification {...props} />)
  expand()
  fireEvent.change(screen.getByLabelText(ja.verificationCommit), { target: { value: commit } })
  await click(ja.verificationSetTarget)
  expect(screen.getByRole('alert').textContent).toBe(ja.verificationOperationFailed)
  expect(screen.getByLabelText<HTMLInputElement>(ja.verificationCommit).value).toBe(commit)
  expect(screen.queryByText('private backend diagnostic')).toBeNull()
  expect(screen.queryByText(ja.verificationPassed)).toBeNull()
})

it('shows the bounded condition, exact tested version, source request and evidence links', () => {
  const props = setup({ ...view, target, status: 'passed', history: [{ target, current: true, observation: {
    seq: SessionSeq(9), targetSeq: target.seq, observedAt: 1794031741000, outcome: 'passed', reason: 'condition-passed',
    run: { id: 123, attempt: 2, url: 'https://github.com/hallucinario/dot-files/actions/runs/123', commit, event: 'push' },
    job: { id: 456, url: 'https://github.com/hallucinario/dot-files/actions/runs/123/job/456', name: check.jobName, conclusion: 'success' },
  } }] })
  render(<MyDotVerification {...props} />)
  expect(screen.getByText(ja.verificationPassed)).toBeTruthy()
  expect(screen.getByText(commit)).toBeTruthy()
  expect(screen.getByText(`${check.repository} · ${check.jobName}`)).toBeTruthy()
  expand()
  expect(screen.getAllByText(commit).length).toBeGreaterThan(0)
  expect(screen.getAllByText(request.text).length).toBeGreaterThan(0)
  expect(screen.getByText(ja.verificationScope)).toBeTruthy()
  expect(screen.getByRole('link', { name: props.t('verificationRun', { id: 123, attempt: 2 }) }).getAttribute('href')).toBe(props.verification.history[0]!.observation.run!.url)
  expect(screen.getByRole('link', { name: props.t('verificationJob', { name: check.jobName, id: 456 }) }).getAttribute('rel')).toBe('noopener noreferrer')
  expect(screen.getByText('2026-11-07T06:09:01.000Z')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: ja.verificationOpenRequest }))
  expect(props.openConversation).toHaveBeenCalledWith(child)
})

it('keeps an earlier success in history when another commit is unobserved or the condition changes', () => {
  const old = { target, current: false, observation: { seq: SessionSeq(9), targetSeq: target.seq,
    observedAt: 1794031741000, outcome: 'passed' as const, reason: 'condition-passed' as const } }
  const props = setup({ ...view, target: { ...target, seq: SessionSeq(10), commit: 'd'.repeat(40) }, history: [old] })
  const rendered = render(<MyDotVerification {...props} />)
  expect(screen.getByText(ja.verificationUnobserved)).toBeTruthy()
  expect(screen.queryByText(ja.verificationPassed)).toBeNull()
  expand()
  expect(screen.getByText(ja.verificationHistorical)).toBeTruthy()
  expect(screen.getByText(ja.verificationPassed)).toBeTruthy()
  rendered.rerender(<MyDotVerification {...props} verification={{ ...props.verification, definitionCurrent: false, status: 'unavailable' }} />)
  expect(screen.getByText(ja.verificationDefinitionChanged)).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: ja.verificationRead }).disabled).toBe(true)
})

it('reads only the supplied existing run for the selected target and waits for the Host snapshot', async () => {
  const props = setup({ ...view, target })
  const pending = Promise.withResolvers<undefined>()
  props.refreshVerification.mockReturnValue(pending.promise)
  render(<MyDotVerification {...props} />)
  expand()
  const read = screen.getByRole<HTMLButtonElement>('button', { name: ja.verificationRead })
  expect(read.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText(ja.verificationRunId), { target: { value: '123' } })
  await click(ja.verificationRead)
  expect(props.refreshVerification).toHaveBeenCalledExactlyOnceWith(child, target.seq, 123)
  expect(read.disabled).toBe(true)
  await act(async () => { pending.resolve(undefined) })
  expect(screen.getByText(ja.verificationUnobserved)).toBeTruthy()
  expect(screen.queryByText(ja.verificationPassed)).toBeNull()
})

it('distinguishes failed, unavailable, and invalid records without repeating a read on reconnect', () => {
  const props = setup({ ...view, target, status: 'failed' })
  const rendered = render(<MyDotVerification {...props} />)
  expect(screen.getByText(ja.verificationFailed)).toBeTruthy()
  expand()
  rendered.rerender(<MyDotVerification {...props} disabled verification={{ ...props.verification, status: 'unavailable', invalidRecords: true,
    history: [{ target, current: true, observation: { seq: SessionSeq(9), targetSeq: target.seq, observedAt: 1794031741000,
      outcome: 'unavailable', reason: 'provider-unavailable' } }] }} />)
  expect(screen.getAllByText(ja.verificationUnavailable).length).toBeGreaterThan(0)
  expect(screen.getByText(ja.verificationReasonProviderUnavailable)).toBeTruthy()
  expect(screen.getByText(ja.verificationInvalidRecords)).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: ja.verificationSetTarget }).disabled).toBe(true)
  expect(props.refreshVerification).not.toHaveBeenCalled()
})

it('does not add controls to conversations without this configured capability', () => {
  const props = setup()
  const result = render(<MyDotVerification {...props} verification={undefined} checks={[]} />)
  expect(result.container.textContent).toBe('')
})

it('shows an unavailable binding choice without manufacturing a request or condition', () => {
  const props = { ...setup({ ...view, requests: [] }), checks: [] }
  const result = render(<MyDotVerification {...props} />)
  expand()
  expect(screen.getByText(ja.verificationNoRequests)).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: ja.verificationSetTarget }).disabled).toBe(true)
  result.rerender(<MyDotVerification {...props} verification={{ ...view, target, definitionCurrent: false }} />)
  expect(screen.getByRole<HTMLOptionElement>('option', { name: check.description }).disabled).toBe(true)
  expect(screen.getByText(ja.verificationDefinitionChanged)).toBeTruthy()
})

it('retains a run ID after an interrupted read and never converts its receipt into a successful condition', async () => {
  const props = setup({ ...view, target })
  props.refreshVerification.mockRejectedValue(new Error('private connection detail'))
  render(<MyDotVerification {...props} />)
  expand()
  fireEvent.change(screen.getByLabelText(ja.verificationRunId), { target: { value: '123' } })
  await click(ja.verificationRead)
  expect(screen.getByLabelText<HTMLInputElement>(ja.verificationRunId).value).toBe('123')
  expect(screen.getByRole('alert').textContent).toBe(ja.verificationOperationFailed)
  expect(screen.queryByText('private connection detail')).toBeNull()
  expect(screen.getByText(ja.verificationUnobserved)).toBeTruthy()
})

it('keeps two jobs independent and rejects incomplete commit and run identifiers', async () => {
  const a = setup({ ...view, target })
  const b = { ...setup({ ...view, target }), sessionId: 'child-b' as SessionId }
  render(<><MyDotVerification {...a} /><MyDotVerification {...b} /></>)
  const regions = screen.getAllByRole('region', { name: ja.verificationTitle })
  fireEvent.click(within(regions[0]!).getByRole('button', { name: ja.verificationDetails }))
  const first = within(regions[0]!)
  fireEvent.change(first.getByLabelText(ja.verificationCommit), { target: { value: 'short' } })
  expect(first.getByRole<HTMLButtonElement>('button', { name: ja.verificationSetTarget }).disabled).toBe(true)
  fireEvent.change(first.getByLabelText(ja.verificationRunId), { target: { value: '123;echo' } })
  expect(first.getByRole<HTMLButtonElement>('button', { name: ja.verificationRead }).disabled).toBe(true)
  fireEvent.change(first.getByLabelText(ja.verificationRunId), { target: { value: '123' } })
  await act(async () => { fireEvent.click(first.getByRole('button', { name: ja.verificationRead })) })
  expect(a.refreshVerification).toHaveBeenCalledWith(child, target.seq, 123)
  expect(b.refreshVerification).not.toHaveBeenCalled()
  expect(within(regions[1]!).queryByLabelText(ja.verificationRunId)).toBeNull()
})

it('keeps the confirmed scope explicit in each supported locale', () => {
  const rendered = [en, ja, zh].map((dictionary) => {
    const props = { ...setup({ ...view, target, status: 'passed' }), t: makeTranslate(dictionary) }
    const result = render(<MyDotVerification {...props} />)
    const region = screen.getByRole('region', { name: dictionary.verificationTitle })
    fireEvent.click(within(region).getByRole('button', { name: dictionary.verificationDetails }))
    const text = { status: within(region).getByRole('status').textContent, scope: within(region).getByText(dictionary.verificationScope).textContent }
    result.unmount()
    return text
  })
  expect(rendered).toMatchInlineSnapshot(`
    [
      {
        "scope": "Evidence applies only to the selected request, condition and commit. It does not verify current files, uncommitted edits or acceptance of the whole job.",
        "status": "Specified condition confirmed for this commit",
      },
      {
        "scope": "証拠の対象は、選択した依頼・条件・コミットに限ります。現在のファイル、未コミットの編集、仕事全体の受入を確認したものではありません。",
        "status": "このコミットの指定条件を確認済み",
      },
      {
        "scope": "证据仅适用于选定请求、条件和提交，不验证当前文件、未提交的修改或整个工作的验收。",
        "status": "已确认此提交的指定条件",
      },
    ]
  `)
})
