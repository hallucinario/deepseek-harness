/** Filing authority, uncertain delivery and independent recording evidence. */
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FilingWorkflow, planDigest } from '../src/filing.ts'
import { filingPlanSchema, recorderStatusSchema } from '../src/filing-state.ts'
import type { FilingView, RecorderStatus, MockReceipt } from '../src/filing-types.ts'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const fixturePlan = () => filingPlanSchema.parse({
  caseId: 'case-27', legalEntity: 'Synthetic Corporation', account: 'mock-account', site: 'local-synthetic-recipient',
  period: { from: '2025-01-01', to: '2025-12-31' }, tax: 'synthetic-income', destination: 'mock-local', amount: '1000', currency: 'JPY',
  forms: ['mock-return'], files: [{ role: 'source', path: 'source.txt', digest: hash('source') },
    { role: 'preview', path: 'preview.txt', digest: hash('preview') }, { role: 'attachment', path: 'attachment.txt', digest: hash('attachment') }],
  inputDestinations: ['local-preview'], modelDestinations: [], expiresAt: 2000, stopRef: 'owner-cancel', queryRef: 'mock-intent-query',
  effects: { submit: true, payment: 'none', standingSettings: 'none' },
})
function setup() {
  let saved: FilingView | undefined
  let now = 1000; let flush = true; let accepted = 0; let loseResponse = false; let fenced = false
  let recorderChange: Partial<RecorderStatus> = {}
  const files = new Map([['source.txt', 'source'], ['preview.txt', 'preview'], ['attachment.txt', 'attachment']])
  const commits: FilingView[] = []; const receipts = new Map<string, MockReceipt>()
  const port = {
    load: () => saved,
    persist: async (view: FilingView) => { if (!flush) throw new Error('flush failed'); saved = structuredClone(view); commits.push(saved) },
    read: async (path: string) => { const text = files.get(path); if (text === undefined) throw new Error('missing'); return text },
    returnControl: async () => undefined, now: () => now, fence: async () => { fenced = true }, recorderMaxAgeMs: 50,
    recorder: async (caseId: string, digest: string) => recorderStatusSchema.parse({ version: 'high-impact-recorder/v1', caseId,
      planDigest: digest, state: 'recording', evidence: 'complete', readyForConfirmation: true, sequence: 1, observedAt: now,
      archiveRef: 'archive-1', segments: ['segment-1'], protectedIntervals: [], gaps: [],
      ...recorderChange }),
    recipient: { query: async (intentId: string) => receipts.get(intentId) ?? null,
      confirm: async (intent: Omit<MockReceipt, 'receiptId'>) => {
        if (!receipts.has(intent.intentId)) { accepted++; receipts.set(intent.intentId, { ...intent, receiptId: 'mock-receipt-1' }) }
        if (loseResponse) throw new Error('lost response')
        return receipts.get(intent.intentId)!
      } },
  }
  const workflow = new FilingWorkflow(port)
  const prepare = () => workflow.prepare(SessionId('original'), fixturePlan())
  const approve = async () => { const view = await prepare(); return workflow.approve(view.revision, view.planDigest) }
  const intent = async () => { const view = await approve(); return workflow.begin(view.revision, view.planDigest, true) }
  return { workflow, port, prepare, approve, intent, files, commits, receipts, saved: () => saved!,
    accepted: () => accepted, fenced: () => fenced,
    expire: () => { now = 2000 }, failFlush: () => { flush = false }, lose: () => { loseResponse = true },
    recording: (change: Partial<RecorderStatus>) => { recorderChange = change } }
}
it('binds digest to year, amount, attachments and auto-debit and checks current files', async () => {
  const h = setup(); const first = await h.approve()
  for (const changed of [{ ...fixturePlan(), period: { from: '2024-01-01', to: '2024-12-31' } }, { ...fixturePlan(), amount: '1001' },
    { ...fixturePlan(), files: fixturePlan().files.map(file => file.role === 'attachment' ? { ...file, digest: hash('new') } : file) },
    { ...fixturePlan(), effects: { submit: true, payment: 'none', standingSettings: 'auto-debit' } }]) {
    expect(planDigest(filingPlanSchema.parse(changed))).not.toBe(first.planDigest)
  }
  h.files.set('attachment.txt', 'swapped')
  await expect(h.workflow.begin(first.revision, first.planDigest, true)).rejects.toThrow(/changed/); expect(h.accepted()).toBe(0)
})
it('revising amount invalidates approval and rejects the old owner decision', async () => {
  const h = setup(); const first = await h.approve()
  const changed = await h.workflow.prepare(SessionId('original'), { ...fixturePlan(), amount: '2000' })
  expect(changed.phase).toBe('prepared'); expect(changed.revision).toBe(2); expect(changed.previousPlan?.amount).toBe('1000')
  await expect(h.workflow.begin(first.revision, first.planDigest, true)).rejects.toThrow(/revision/)
})
it('rejects expiry and revocation and never publishes intent after flush failure', async () => {
  const expired = setup(); const view = await expired.approve(); expired.expire()
  await expect(expired.workflow.begin(view.revision, view.planDigest, true)).rejects.toThrow(/expired/)
  const revoked = setup(); const approved = await revoked.approve(); await revoked.workflow.cancel(approved.revision, approved.planDigest)
  await expect(revoked.workflow.begin(approved.revision, approved.planDigest, true)).rejects.toThrow(/cancelled/)
  const failed = setup(); const pending = await failed.approve(); failed.failFlush()
  await expect(failed.workflow.begin(pending.revision, pending.planDigest, true)).rejects.toThrow(/flush/)
  expect(failed.saved().phase).toBe('approved'); expect(failed.accepted()).toBe(0)
})
it('fences controls then persists intent and deduplicates double confirmation', async () => {
  const h = setup(); const view = await h.intent()
  expect(h.fenced()).toBe(true); expect(view.phase).toBe('intent'); expect(h.accepted()).toBe(0)
  expect(h.commits.map(view => view.phase)).toEqual(['prepared', 'approved', 'approved', 'intent'])
  await Promise.all([h.workflow.confirm(view.revision, view.planDigest), h.workflow.confirm(view.revision, view.planDigest)])
  expect(h.accepted()).toBe(1); expect(h.saved().phase).toBe('accepted')
})
it('queries after lost response and restart without resending', async () => {
  const h = setup(); const view = await h.intent(); h.lose()
  expect((await h.workflow.confirm(view.revision, view.planDigest)).phase).toBe('unknown')
  expect((await new FilingWorkflow(h.port).reconcile()).phase).toBe('accepted'); expect(h.accepted()).toBe(1)
})
it('requires fresh matching independent recorder and exclusive closed admission', async () => {
  for (const change of [{ caseId: 'other' }, { planDigest: 'b'.repeat(64) }, { observedAt: 900 }, { readyForConfirmation: false },
    { state: 'protected' as const }]) {
    const h = setup(); const view = await h.approve(); h.recording(change)
    await expect(h.workflow.begin(view.revision, view.planDigest, true)).rejects.toThrow(/recorder/i); expect(h.accepted()).toBe(0)
  }
})
it('retains accepted plus recording gap and rejects mismatched recipient forms', async () => {
  const h = setup(); const view = await h.intent(); h.recording({ evidence: 'partial', gaps: ['gap-1'] })
  const result = await h.workflow.confirm(view.revision, view.planDigest)
  expect(result.phase).toBe('accepted'); expect(result.recorder?.evidence).toBe('partial')
  const bad = setup(); const pending = await bad.intent()
  bad.receipts.set(pending.intentId!, { receiptId: 'wrong', intentId: pending.intentId!, caseId: pending.plan.caseId, planDigest: pending.planDigest, forms: ['other'] })
  await expect(bad.workflow.confirm(pending.revision, pending.planDigest)).rejects.toThrow(/receipt/i)
})
it('rejects secret-bearing event fields and stores only protected interval references', () => {
  const status = { version: 'high-impact-recorder/v1', caseId: 'case-27', planDigest: 'a'.repeat(64), state: 'protected',
    evidence: 'partial', readyForConfirmation: false, sequence: 2, observedAt: 1000, archiveRef: 'archive-1', segments: [],
    protectedIntervals: ['protected-1'], gaps: [] }
  expect(recorderStatusSchema.parse(status).protectedIntervals).toEqual(['protected-1'])
  for (const key of ['password', 'otp', 'cookies', 'dom', 'network', 'screenshot']) expect(() => recorderStatusSchema.parse({ ...status, [key]: 'secret' })).toThrow()
})

it('requires independent stopped recorder evidence before explicitly returning app controls', async () => {
  const h = setup(); const view = await h.intent(); await h.workflow.confirm(view.revision, view.planDigest)
  await expect(h.workflow.returnControl(view.revision, view.planDigest)).rejects.toThrow(/Recorder/)
  h.recording({ state: 'stopped', readyForConfirmation: false })
  expect((await h.workflow.returnControl(view.revision, view.planDigest)).control).toBe('return-authorized')
})
it('queries before rearming an unattempted intent after restart, while unknown remains query-only', async () => {
  const h = setup(); const view = await h.intent()
  const cold = new FilingWorkflow(h.port)
  expect((await cold.reconcile()).phase).toBe('intent')
  expect(cold.ready()).toBe(false)
  expect((await cold.begin(view.revision, view.planDigest, true)).intentId).toBe(view.intentId)
  await cold.confirm(view.revision, view.planDigest); expect(h.accepted()).toBe(1)
})

it('requires an explicit owner assertion before closing external controllers for this revision', async () => {
  const h = setup(); const view = await h.approve()
  await expect(h.workflow.begin(view.revision, view.planDigest, false)).rejects.toThrow(/owner.*confirm/i)
  expect(h.fenced()).toBe(false); expect(h.accepted()).toBe(0)
  const intent = await h.workflow.begin(view.revision, view.planDigest, true)
  expect(intent.ownerControlConfirmation).toEqual({ revision: view.revision, planDigest: view.planDigest, confirmedAt: 1000, source: 'host-owner' })
})
it('publishes human ownership only after the app controls have drained', async () => {
  const h = setup(); const view = await h.approve()
  const drain = Promise.withResolvers<undefined>()
  h.port.fence = async () => drain.promise
  const begin = h.workflow.begin(view.revision, view.planDigest, true)
  await vi.waitFor(() => { expect(h.saved().control).toBe('stopping') })
  drain.resolve(undefined)
  expect((await begin).control).toBe('human')
})

it('retains case and Session identity, rejects expired preparation, and deduplicates unchanged plans', async () => {
  const empty = setup()
  await expect(empty.workflow.approve(1, hash('missing'))).rejects.toThrow('Filing not found')
  const first = await empty.prepare()
  expect(await empty.prepare()).toBe(empty.saved())
  expect(empty.commits).toHaveLength(1)
  await expect(empty.workflow.prepare(SessionId('other'), fixturePlan())).rejects.toThrow(/another Session/)
  const expired = setup(); expired.expire()
  await expect(expired.prepare()).rejects.toThrow(/expired/)
  const invalid = setup(); const approved = await invalid.approve()
  invalid.files.set('source.txt', 'changed')
  await expect(invalid.workflow.approve(approved.revision, approved.planDigest)).rejects.toThrow(/changed/)
  await expect(invalid.workflow.approve(approved.revision, approved.planDigest)).rejects.toThrow(/invalidated/)
  invalid.files.set('source.txt', 'source')
  expect((await invalid.prepare()).revision).toBe(2)
  expect(first.revision).toBe(1)
})
it('does not replace owner-held or consumed cases and requires approval before intent', async () => {
  const h = setup(); const prepared = await h.prepare()
  await expect(h.workflow.begin(prepared.revision, prepared.planDigest, true)).rejects.toThrow(/Approve/)
  await expect(h.workflow.confirm(prepared.revision, prepared.planDigest)).rejects.toThrow(/No persisted/)
  await expect(h.workflow.returnControl(prepared.revision, prepared.planDigest)).rejects.toThrow(/Finish or cancel/)
  const intent = await h.intent()
  expect(await h.workflow.begin(intent.revision, intent.planDigest, true)).toBe(h.saved())
  await expect(h.prepare()).rejects.toThrow(/Return owner control/)
  h.saved().control = 'agent'
  await expect(h.prepare()).rejects.toThrow(/cannot be replaced/)
  await expect(h.workflow.approve(intent.revision, intent.planDigest)).rejects.toThrow(/no longer awaiting/)
})
it('uses a known receipt when reentering intent and never permits cancelling an accepted effect', async () => {
  const h = setup(); const pending = await h.intent()
  h.receipts.set(pending.intentId!, { receiptId: 'receipt', intentId: pending.intentId!, caseId: pending.plan.caseId,
    planDigest: pending.planDigest, forms: pending.plan.forms })
  const cold = new FilingWorkflow(h.port)
  expect((await cold.begin(pending.revision, pending.planDigest, true)).phase).toBe('accepted')
  expect(await cold.reconcile()).toBe(h.saved())
  await expect(cold.cancel(pending.revision, pending.planDigest)).rejects.toThrow(/cannot undo/)
  expect(h.accepted()).toBe(0)
})
it('keeps unresolved confirmations query-only and allows returning an already agent-owned cancellation', async () => {
  const h = setup(); const pending = await h.intent(); h.lose()
  await h.workflow.confirm(pending.revision, pending.planDigest)
  h.receipts.clear()
  await expect(h.workflow.cancel(pending.revision, pending.planDigest)).rejects.toThrow(/cannot undo/)
  await expect(h.workflow.confirm(pending.revision, pending.planDigest)).rejects.toThrow(/never resend/)
  expect((await h.workflow.reconcile()).phase).toBe('unknown')
  const empty = setup(); const view = await empty.approve()
  expect(await empty.workflow.reconcile()).toBe(empty.saved())
  await empty.workflow.cancel(view.revision, view.planDigest)
  expect(await empty.workflow.returnControl(view.revision, view.planDigest)).toBe(empty.saved())
})
it('retains acceptance independently of unavailable capture and never invents missing evidence', async () => {
  const h = setup(); const pending = await h.intent()
  const confirm = h.port.recipient.confirm
  h.port.recipient.confirm = async (intent) => {
    const receipt = await confirm(intent)
    h.port.recorder = async () => { throw new Error('capture unavailable') }
    return receipt
  }
  const result = await h.workflow.confirm(pending.revision, pending.planDigest)
  expect(result.phase).toBe('accepted'); expect(result.recorder?.evidence).toBe('unavailable')
  expect(result.recorder?.readyForConfirmation).toBe(false)
  const cold = setup(); const prepared = await cold.prepare(); const intentId = 'known-intent'
  await cold.port.persist({ ...prepared, phase: 'intent', intentId })
  cold.receipts.set(intentId, { receiptId: 'receipt', intentId, caseId: prepared.plan.caseId, planDigest: prepared.planDigest, forms: prepared.plan.forms })
  cold.port.recorder = async () => { throw new Error('capture unavailable') }
  const recovered = await cold.workflow.reconcile()
  expect(recovered.phase).toBe('accepted'); expect(recovered.recorder).toBeUndefined()
})
it('rejects future, unavailable, empty and regressing recorder observations', async () => {
  for (const change of [{ observedAt: 1001 }, { evidence: 'unavailable' as const }, { segments: [] }, { sequence: 0 }]) {
    const h = setup(); const pending = await h.intent(); h.recording(change)
    await expect(h.workflow.confirm(pending.revision, pending.planDigest)).rejects.toThrow(/Recorder/)
    expect(h.accepted()).toBe(0)
  }
})

it.each(['return', 'cancel'] as const)('preserves invalidation after restart and an empty receipt query before owner %s', async (action) => {
  const h = setup(); const pending = await h.intent()
  const confirm = vi.spyOn(h.port.recipient, 'confirm')
  h.files.set('source.txt', 'changed after intent')
  await expect(h.workflow.confirm(pending.revision, pending.planDigest)).rejects.toThrow(/files changed/)
  expect(confirm).not.toHaveBeenCalled()
  const invalidated = structuredClone(h.saved())
  expect(invalidated).toMatchObject({ phase: 'invalidated', control: 'human', reason: 'files-changed', intentId: pending.intentId })
  const cold = new FilingWorkflow(h.port)
  const query = vi.spyOn(h.port.recipient, 'query')
  expect(await cold.reconcile()).toEqual(invalidated)
  expect(query).toHaveBeenCalledExactlyOnceWith(pending.intentId)
  expect(cold.ready()).toBe(false)
  if (action === 'cancel') expect((await cold.cancel(pending.revision, pending.planDigest)).phase).toBe('cancelled')
  h.recording({ state: 'stopped', readyForConfirmation: false, sequence: 2 })
  expect(await cold.returnControl(pending.revision, pending.planDigest)).toMatchObject({
    phase: action === 'cancel' ? 'cancelled' : 'invalidated', control: 'return-authorized', intentId: pending.intentId,
  })
  expect(confirm).not.toHaveBeenCalled()
})

it('honors an independent receipt when querying an invalidated intent after restart', async () => {
  const h = setup(); const pending = await h.intent()
  h.files.set('preview.txt', 'changed after intent')
  await expect(h.workflow.confirm(pending.revision, pending.planDigest)).rejects.toThrow(/files changed/)
  const receipt: MockReceipt = { receiptId: 'independent-receipt', intentId: pending.intentId!, caseId: pending.plan.caseId,
    planDigest: pending.planDigest, forms: pending.plan.forms }
  h.receipts.set(receipt.intentId, receipt)
  const query = vi.spyOn(h.port.recipient, 'query')
  expect(await new FilingWorkflow(h.port).reconcile()).toMatchObject({ phase: 'accepted', receipt, control: 'human' })
  expect(query).toHaveBeenCalledExactlyOnceWith(pending.intentId)
  expect(h.accepted()).toBe(0)
})

it('keeps a genuinely unknown confirmation query-only after restart and an empty receipt query', async () => {
  const h = setup(); const pending = await h.intent()
  const confirm = vi.spyOn(h.port.recipient, 'confirm').mockRejectedValue(new Error('recipient outcome unknown'))
  expect((await h.workflow.confirm(pending.revision, pending.planDigest)).phase).toBe('unknown')
  const cold = new FilingWorkflow(h.port)
  const query = vi.spyOn(h.port.recipient, 'query')
  expect((await cold.reconcile()).phase).toBe('unknown')
  expect(query).toHaveBeenCalledExactlyOnceWith(pending.intentId)
  h.recording({ state: 'stopped', readyForConfirmation: false, sequence: 2 })
  await expect(cold.cancel(pending.revision, pending.planDigest)).rejects.toThrow(/cannot undo/)
  await expect(cold.returnControl(pending.revision, pending.planDigest)).rejects.toThrow(/Finish or cancel/)
  await expect(cold.begin(pending.revision, pending.planDigest, true)).rejects.toThrow(/query/)
  await expect(cold.confirm(pending.revision, pending.planDigest)).rejects.toThrow(/never resend/)
  expect(confirm).toHaveBeenCalledOnce()
})
