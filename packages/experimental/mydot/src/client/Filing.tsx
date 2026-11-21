/** Owner review and local synthetic confirmation within the existing MyDot panel. */
import { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { FilingCardView, FilingView } from '../filing-types.ts'
import type { NS } from './locales.ts'
import css from './MyDot.module.css'
/** Explicit owner operations; no render or reconnect automatically confirms. */
export type FilingCommand = 'approve' | 'begin' | 'confirmMock' | 'reconcile' | 'cancel' | 'returnControl'
interface Props extends PropsLocale<typeof NS> {
  card: FilingCardView
  command?: ((command: FilingCommand, filing: FilingView, externalControlsClosed?: boolean) => Promise<void>) | undefined
  open: () => void
  openFile?: ((path: string) => void) | undefined
}
/** Render exact plan/effects, prior revision and separate receipt/recording states.
 * @param props - Canonical owner view, live readiness and explicit commands.
 * @returns Responsive filing review card.
 */
export function FilingCard({ card, command, open, openFile, t }: Props) {
  const { filing, confirmationReady } = card
  const plan = filing.plan
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const [controlConfirmation, setControlConfirmation] = useState('')
  const binding = `${filing.revision}:${filing.planDigest}`
  const externalControlsClosed = controlConfirmation === binding
  const run = (action: FilingCommand): void => {
    if (busy.current || command === undefined) return
    busy.current = true; setPending(true); setError('')
    const result = action === 'begin' ? command(action, filing, externalControlsClosed) : command(action, filing)
    void result.catch((reason: unknown) => {
      setError(String(reason)); if (action === 'confirmMock' || action === 'begin') setUncertain(true)
    }).finally(() => { busy.current = false; setPending(false) })
  }
  const phase = filing.phase === 'prepared' ? 'filingPrepared' : filing.phase === 'approved' ? 'filingApproved'
    : filing.phase === 'intent' ? 'filingIntent' : filing.phase === 'unknown' ? 'filingUnknown'
      : filing.phase === 'accepted' ? 'filingAccepted' : filing.phase === 'cancelled' ? 'filingCancelled' : 'filingInvalidated'
  const changed = filing.previousPlan === undefined ? [] : (Object.keys(plan) as (keyof typeof plan)[])
    .filter(key => JSON.stringify(plan[key]) !== JSON.stringify(filing.previousPlan?.[key]))
  return <article className={css.card} data-filing-case={plan.caseId}>
    <h2 className={css.heading}>{t('filingTitle')} · {plan.caseId}</h2>
    <p role="status">{t(phase)}</p>
    <p className={css.text}>{t('filingActor')}: {t(filing.actor === 'host-owner' ? 'humanOwner' : 'filingPreparer')} · {filing.sessionId}</p>
    <p className={css.text}>{t('humanVersion')} {filing.revision} · {filing.planDigest}</p>
    <p className={css.text}>{plan.legalEntity} · {plan.account} · {plan.site} · {plan.destination}</p>
    <p className={css.text}>{plan.period.from} — {plan.period.to} · {plan.tax} · {plan.amount} {plan.currency}</p>
    <p className={css.text}>{t('filingForms')}: {plan.forms.join(', ')}</p>
    <p className={css.text}>{t('filingEffects')}: {t('filingSubmit')} {t(plan.effects.submit ? 'filingYes' : 'filingNo')} ·
      {t('filingPayment')} {t(plan.effects.payment === 'none' ? 'filingNo' : 'filingOneTime')} ·
      {t('filingStanding')} {t(plan.effects.standingSettings === 'none' ? 'filingNo' : 'filingAutoDebit')}</p>
    <p className={css.text}>{t('filingExpiry')}: {new Date(plan.expiresAt).toISOString()} · {plan.stopRef} · {plan.queryRef}</p>
    <p className={css.text}>{t('filingDestinations')}: {JSON.stringify({ input: plan.inputDestinations, model: plan.modelDestinations })}</p>
    {plan.files.map((file, index) => <div key={`${file.path}:${index}`}>
      <p className={css.text}>{t('filingFile')}: {file.role} · {file.path}</p>
      <Button disabled={openFile === undefined} aria-label={`${t('filingOpenFile')} ${file.path}`}
        onClick={() => { openFile?.(file.path) }}>{t('filingOpenFile')}</Button>
      <details><summary>{t('humanVersion')}</summary><p className={css.text}>{file.digest}</p></details>
    </div>)}
    {filing.previousPlan !== undefined && <details><summary>{t('filingDiff')}</summary>
      {changed.map(key => <p className={css.text} key={key}>
        {key}: {JSON.stringify(filing.previousPlan?.[key])} → {JSON.stringify(plan[key])}
      </p>)}
    </details>}
    {filing.reason !== undefined && <p className={css.text}>{t('filingReason')}: {filing.reason}</p>}
    <p className={css.text}>{t('filingReceipt')}: {filing.receipt?.receiptId ?? t('filingNoReceipt')}</p>
    <p className={css.text}>{t('filingRecording')}: {filing.recorder === undefined ? t('filingUnavailable')
      : t(filing.recorder.evidence === 'complete' ? 'filingComplete' : filing.recorder.evidence === 'partial' ? 'filingPartial' : 'filingUnavailable')}</p>
    {filing.recorder !== undefined && <p className={css.text}>{filing.recorder.archiveRef} · {filing.recorder.segments.join(', ')} ·
      {t('filingGaps')}: {filing.recorder.gaps.join(', ')} · {t('filingProtected')}: {filing.recorder.protectedIntervals.join(', ')}</p>}
    <p className={css.text}>{t('filingSyntheticOnly')}</p>
    {filing.control === 'return-authorized' && <p className={css.text}>{t('filingReturnAuthorized')}</p>}
    {['approved', 'intent'].includes(filing.phase) && <label className={css.field}>
      <input type="checkbox" checked={externalControlsClosed} disabled={pending}
        onChange={(event) => { setControlConfirmation(event.target.checked ? binding : '') }} />{t('filingControlsClosed')}
    </label>}
    <div className={css.row}>
      {filing.phase === 'prepared' && <Button disabled={pending || command === undefined} onClick={() => { run('approve') }}>{t('filingApprove')}</Button>}
      {filing.phase === 'approved' && <Button disabled={pending || uncertain || !externalControlsClosed || command === undefined} onClick={() => { run('begin') }}>{t('filingBegin')}</Button>}
      {filing.phase === 'intent' && !confirmationReady && <Button disabled={pending || !externalControlsClosed || command === undefined} onClick={() => { run('begin') }}>{t('filingResume')}</Button>}
      {filing.phase === 'intent' && !uncertain && <Button disabled={pending || !confirmationReady || command === undefined}
        onClick={() => { run('confirmMock') }}>{t('filingConfirm')}</Button>}
      {filing.intentId !== undefined && <Button disabled={pending || command === undefined} onClick={() => { run('reconcile') }}>{t('filingQuery')}</Button>}
      {['prepared', 'approved', 'intent'].includes(filing.phase) && <Button disabled={pending || command === undefined} onClick={() => { run('cancel') }}>{t('humanCancel')}</Button>}
      {filing.control !== 'agent' && ['accepted', 'cancelled', 'invalidated'].includes(filing.phase) && <Button disabled={pending || command === undefined} onClick={() => { run('returnControl') }}>{t('filingReturn')}</Button>}
      <Button onClick={open}>{t('open')}</Button>
    </div>
    {error !== '' && <p role="alert" className={css.text}>{t('error', { message: error })}</p>}
  </article>
}
