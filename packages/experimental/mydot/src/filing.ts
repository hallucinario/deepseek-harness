/** Revision-bound owner decisions and synthetic confirmation, with query-only unknown recovery. */
import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { filingPlanSchema, mockReceiptSchema } from './filing-state.ts'
import type { FilingPlan, FilingView, MockReceipt, RecorderStatus } from './filing-types.ts'
/** Existing Session writer, current-file reader and trusted host adapters. */
export interface FilingPorts {
  load(): FilingView | undefined
  persist(view: FilingView): Promise<void>
  read(path: string): Promise<string>
  now(): number
  fence(): Promise<void>
  returnControl(): Promise<void>
  recorder(caseId: string, digest: string): Promise<RecorderStatus>
  recorderMaxAgeMs: number
  recipient: { query(intentId: string): Promise<MockReceipt | null>; confirm(intent: Omit<MockReceipt, 'receiptId'>): Promise<MockReceipt> }
}
/** Hash the validated, explicitly ordered plan on the server.
 * @param plan - Complete reviewed plan.
 * @returns SHA-256 covering all identity, file, destination and effect fields.
 */
export function planDigest(plan: FilingPlan): string { return createHash('sha256').update(JSON.stringify(filingPlanSchema.parse(plan))).digest('hex') }

/** One case serializes decisions; no method is registered as an autonomous send tool. */
export class FilingWorkflow {
  private ordered: Promise<unknown> = Promise.resolve()
  private readyIntent: string | undefined
  constructor(private readonly ports: FilingPorts) {}
  /** Whether this live process successfully flushed the confirmation intent.
   * @returns False after restart, failure, cancellation or consumption.
   */
  ready(): boolean { return this.readyIntent !== undefined && this.ports.load()?.phase === 'intent' }
  private run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.ordered.catch(() => undefined).then(work)
    this.ordered = next
    return next
  }
  private current(): FilingView { const view = this.ports.load(); if (view === undefined) throw new Error('Filing not found'); return view }
  private exact(revision: number, digest: string): FilingView {
    const view = this.current()
    if (view.revision !== revision || view.planDigest !== digest || planDigest(view.plan) !== digest) throw new Error('Filing revision or digest changed')
    return view
  }
  private active(view: FilingView): void {
    if (view.phase === 'cancelled' || view.phase === 'invalidated') throw new Error(`Filing is ${view.phase}`)
    if (this.ports.now() >= view.plan.expiresAt) throw new Error('Filing decision expired')
  }
  private async files(plan: FilingPlan): Promise<void> {
    for (const file of plan.files) {
      if (createHash('sha256').update(await this.ports.read(file.path)).digest('hex') !== file.digest) throw new Error('Filing files changed; prepare and review a new revision')
    }
  }
  private async verifyFiles(view: FilingView): Promise<void> {
    try { await this.files(view.plan) }
    catch (error: unknown) {
      this.readyIntent = undefined
      await this.ports.persist({ ...view, phase: 'invalidated', reason: 'files-changed' })
      throw error
    }
  }
  private async recording(view: FilingView): Promise<RecorderStatus> {
    const status = await this.ports.recorder(view.plan.caseId, view.planDigest)
    const age = this.ports.now() - status.observedAt
    if (status.caseId !== view.plan.caseId || status.planDigest !== view.planDigest || age < 0 || age > this.ports.recorderMaxAgeMs ||
      !status.readyForConfirmation || status.state !== 'recording' || status.evidence === 'unavailable' || status.segments.length === 0 ||
      (view.recorder !== undefined && status.sequence < view.recorder.sequence)) throw new Error('Recorder is not ready with a fresh matching observation')
    return status
  }
  /** Persist a reviewed-input candidate; preparation conveys no owner authority.
   * @param sessionId - Actual initiating Session.
   * @param input - Untrusted model fields, revalidated and hashed on the Host.
   * @returns Flushed plan with any prior revision available for diff display.
   */
  prepare(sessionId: SessionId, input: FilingPlan): Promise<FilingView> {
    return this.run(async () => {
      const plan = filingPlanSchema.parse(input)
      if (this.ports.now() >= plan.expiresAt) throw new Error('Filing plan expired')
      const old = this.ports.load()
      if (old !== undefined && (old.sessionId !== sessionId || old.plan.caseId !== plan.caseId)) throw new Error('Case belongs to another Session')
      if (old?.control === 'human') throw new Error('Return owner control before revising the plan')
      if (old !== undefined && ['intent', 'unknown', 'accepted', 'cancelled'].includes(old.phase)) throw new Error('Reconcile or retain the existing intent; this case cannot be replaced')
      await this.files(plan)
      const digest = planDigest(plan)
      if (old?.planDigest === digest && old.phase !== 'invalidated') return old
      this.readyIntent = undefined
      const view: FilingView = { sessionId, plan, revision: (old?.revision ?? 0) + 1, planDigest: digest, phase: 'prepared', actor: 'model-preparer', control: 'agent',
        ...(old === undefined ? {} : { previousPlan: old.plan }) }
      await this.ports.persist(view)
      return view
    })
  }
  /** Save the Host owner's decision for the exact plan.
   * @param revision - Displayed plan revision.
   * @param digest - Displayed server digest.
   * @returns Flushed decision; no confirmation or payment has occurred.
   */
  approve(revision: number, digest: string): Promise<FilingView> {
    return this.run(async () => {
      const view = this.exact(revision, digest); this.active(view)
      if (!['prepared', 'approved'].includes(view.phase)) throw new Error('Filing is no longer awaiting approval')
      await this.verifyFiles(view)
      const next: FilingView = { ...view, phase: 'approved', actor: 'host-owner' }
      await this.ports.persist(next); return next
    })
  }
  /** Fence capture/control, check host evidence and flush intent before enabling confirmation.
   * @param revision - Owner-reviewed revision.
   * @param digest - Owner-reviewed digest.
   * @param externalControlsClosed - Owner assertion that other clients and scheduled operations are stopped.
   * @returns Durable intent, with no recipient operation yet.
   */
  begin(revision: number, digest: string, externalControlsClosed: boolean): Promise<FilingView> {
    return this.run(async () => {
      const view = this.exact(revision, digest); this.active(view)
      if (!externalControlsClosed) throw new Error('The owner must confirm other clients and scheduled controls are stopped for this plan')
      if (view.phase === 'intent' && this.ready()) return view
      if (view.phase !== 'approved' && view.phase !== 'intent') throw new Error('Approve the exact plan before takeover; recover unknown results by query')
      if (view.phase === 'intent' && view.intentId !== undefined) {
        const receipt = await this.ports.recipient.query(view.intentId)
        if (receipt !== null) return this.accept(view, receipt)
      }
      await this.verifyFiles(view)
      const takeover: FilingView = { ...view, control: 'stopping', ownerControlConfirmation: {
        revision, planDigest: digest, confirmedAt: this.ports.now(), source: 'host-owner',
      } }
      await this.ports.persist(takeover)
      await this.ports.fence()
      const recorder = await this.recording(takeover)
      const intentId = `mock-${createHash('sha256').update(`${view.sessionId}:${view.plan.caseId}:${revision}:${digest}`).digest('hex')}`
      const next: FilingView = { ...takeover, control: 'human', phase: 'intent', intentId, recorder, actor: 'host-owner' }
      await this.ports.persist(next)
      this.readyIntent = intentId
      return next
    })
  }
  /** Perform only the local synthetic owner's final confirmation, once per durable intent.
   * @param revision - Exact owner-reviewed revision.
   * @param digest - Exact owner-reviewed digest.
   * @returns Receipt or explicit uncertainty; uncertainty admits queries only.
   */
  confirm(revision: number, digest: string): Promise<FilingView> {
    return this.run(async () => {
      const view = this.exact(revision, digest)
      if (view.phase === 'accepted') return view
      this.active(view)
      if (view.intentId === undefined || !['intent', 'unknown'].includes(view.phase)) throw new Error('No persisted confirmation intent')
      const known = await this.ports.recipient.query(view.intentId)
      if (known !== null) return this.accept(view, known)
      if (view.phase === 'unknown' || this.readyIntent !== view.intentId) throw new Error('Unknown result: query the existing intent; never resend')
      await this.verifyFiles(view)
      const recorder = await this.recording(view)
      const unknown: FilingView = { ...view, phase: 'unknown', recorder, reason: 'confirmation-unknown' }
      await this.ports.persist(unknown)
      this.readyIntent = undefined
      let receipt: MockReceipt
      try {
        receipt = await this.ports.recipient.confirm({ intentId: view.intentId, caseId: view.plan.caseId,
          planDigest: view.planDigest, forms: view.plan.forms })
      }
      catch (_error: unknown) { return unknown /* Query recovers a possibly accepted effect; never repeat it. */ }
      return this.accept(unknown, receipt)
    })
  }
  private async accept(view: FilingView, input: MockReceipt): Promise<FilingView> {
    const receipt = mockReceiptSchema.parse(input)
    if (receipt.intentId !== view.intentId || receipt.caseId !== view.plan.caseId || receipt.planDigest !== view.planDigest ||
      JSON.stringify(receipt.forms) !== JSON.stringify(view.plan.forms)) throw new Error('Recipient receipt does not match the exact intent, plan and forms')
    let recorder = view.recorder
    try { recorder = await this.recording(view) }
    catch (_error: unknown) { if (recorder !== undefined) recorder = { ...recorder, evidence: 'unavailable', readyForConfirmation: false } }
    const next: FilingView = { ...view, phase: 'accepted', receipt, ...(recorder === undefined ? {} : { recorder }) }
    delete next.reason
    await this.ports.persist(next); return next
  }
  /** Recover only by stable recipient intent, including after restart or disconnect.
   * @returns Independently matched acceptance or explicit unresolved state.
   */
  reconcile(): Promise<FilingView> {
    return this.run(async () => {
      const view = this.current()
      if (view.intentId === undefined || view.phase === 'cancelled' || view.phase === 'accepted') return view
      const receipt = await this.ports.recipient.query(view.intentId)
      if (receipt !== null) return this.accept(view, receipt)
      this.readyIntent = undefined
      const next: FilingView = view.phase === 'intent' || view.phase === 'invalidated'
        ? view : { ...view, phase: 'unknown', reason: 'confirmation-unknown' }
      await this.ports.persist(next); return next
    })
  }
  /** Return app control after a fresh matching recorder observation confirms capture has stopped.
   * @param revision - Exact terminal decision revision.
   * @param digest - Exact reviewed digest.
   * @returns Persisted owner return authority; configured desktops still require a new capture.
   */
  returnControl(revision: number, digest: string): Promise<FilingView> {
    return this.run(async () => {
      const view = this.exact(revision, digest)
      if (!['accepted', 'cancelled', 'invalidated'].includes(view.phase)) throw new Error('Finish or cancel the known effect before returning control')
      if (view.control === 'agent') return view
      const status = await this.ports.recorder(view.plan.caseId, view.planDigest)
      const age = this.ports.now() - status.observedAt
      if (status.caseId !== view.plan.caseId || status.planDigest !== view.planDigest || status.state !== 'stopped' ||
        age < 0 || age > this.ports.recorderMaxAgeMs || (view.recorder !== undefined && status.sequence < view.recorder.sequence)) {
        throw new Error('Recorder must independently confirm stopped recording before returning control')
      }
      const next: FilingView = { ...view, control: 'return-authorized', recorder: status }
      await this.ports.persist(next)
      await this.ports.returnControl()
      return next
    })
  }
  /** Revoke a decision before any uncertain or accepted confirmation.
   * @param revision - Exact displayed revision.
   * @param digest - Exact displayed digest.
   * @returns Durable cancellation retaining the reviewed plan.
   */
  cancel(revision: number, digest: string): Promise<FilingView> {
    return this.run(async () => {
      const view = this.exact(revision, digest)
      if (view.phase === 'unknown' || view.phase === 'accepted') throw new Error('Query the existing effect; cancellation cannot undo acceptance')
      this.readyIntent = undefined
      const next: FilingView = { ...view, phase: 'cancelled', actor: 'host-owner', reason: 'owner-cancelled' }
      await this.ports.persist(next); return next
    })
  }
}
