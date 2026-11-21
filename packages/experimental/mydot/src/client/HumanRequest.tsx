/** Versioned owner response with a retained submission identity and explicit receipt states. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HumanAnswer, HumanRequestId, HumanRequestView, HumanSubmissionId } from '../types.ts'
import type { NS } from './locales.ts'
import css from './MyDot.module.css'

/** Browser viewing draft, separate from the authoritative saved answer. */
export interface HumanResponseDraft { choice: string; text: string; submissionId: string }
interface Props extends PropsLocale<typeof NS> {
  view: HumanRequestView
  draft: HumanResponseDraft
  change: (draft: HumanResponseDraft) => void
  answer?: ((answer: HumanAnswer) => Promise<void>) | undefined
  reconcile?: ((id: HumanRequestId) => Promise<void>) | undefined
  cancel?: ((id: HumanRequestId) => Promise<void>) | undefined
  mint: () => string
  selected: boolean
  open: () => void
}

/** A GET/deep-link only selects this card; answers require an explicit button.
 * @param props - Projected request, persisted viewing draft and commands.
 * @returns Accessible response card.
 */
export function HumanRequestCard({ view, draft, change, answer, reconcile, cancel, mint, selected, open, t }: Props) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const request = view.request
  const choices = request.target === null ? [...new Set([...request.options, 'confirmed', 'unknown', 'needs-material', 'deferred', 'rejected'])]
    : ['unknown', 'needs-material', 'deferred', 'rejected']
  const disposition = (choice: string): string => choice === 'confirmed' ? t('humanConfirmed') : choice === 'unknown' ? t('humanUnknown')
    : choice === 'needs-material' ? t('humanNeedsMaterial') : choice === 'deferred' ? t('humanDeferred') : choice === 'rejected' ? t('humanRejected') : choice
  const phase = view.phase === 'pending' ? 'humanPending' : view.phase === 'received' ? 'humanReceived'
    : view.phase === 'resumed' ? 'humanResumed' : view.phase === 'outcome' ? 'humanOutcome' : view.phase === 'retired' ? 'humanRetired' : view.phase === 'stopped' ? 'humanStopped' : 'humanQueued'
  return <article className={`${css.card} ${selected ? css.humanSelected : ''}`} id={`human-request-${request.requestId}`} tabIndex={-1}>
    <h3 className={css.heading}>{request.question}</h3>
    <p className={css.text}>{request.reason}</p>
    <p className={css.text}>{t('humanOwner')} · {request.requestId} · {t('humanVersion')} {request.requestRevision}</p>
    {request.target !== null && <p className={css.text}>
      {request.target.caseId} · {request.target.sourceId} · {request.target.sourceRevision} · {request.target.baseRevisionId}
    </p>}
    {request.evidenceUrl !== '' && <a href={request.evidenceUrl} rel="noreferrer">{t('humanEvidence')}</a>}
    <p className={css.text}>{t('humanNext')}: {request.resumeInstruction}</p>
    <p role="status">{t(phase)}</p>
    {view.reason !== undefined && <p className={css.text}>{view.reason}</p>}
    {view.answer !== undefined && <p className={css.text}>{disposition(view.answer.choice)} {view.answer.text}</p>}
    {view.outcome !== undefined && <p className={css.text}>{view.outcome}: {view.evidence}</p>}
    {view.phase === 'pending' && <>
      <label className={css.field}>{t('humanResponse')}<select className={css.input} value={draft.choice} disabled={pending}
        onChange={(event) => { change({ ...draft, choice: event.target.value, submissionId: '' }) }}>
        <option value="">{t('humanChoose')}</option>
        {choices.map(choice => <option key={choice} value={choice}>{disposition(choice)}</option>)}
      </select></label>
      <label className={css.field}>{t('humanDetails')}<textarea className={css.input} value={draft.text} disabled={pending}
        onChange={(event) => { change({ ...draft, text: event.target.value, submissionId: '' }) }} /></label>
      <Button disabled={pending || answer === undefined || draft.choice === ''} onClick={() => {
        const submissionId = draft.submissionId || mint()
        change({ ...draft, submissionId })
        setPending(true); setError('')
        void answer?.({ requestId: request.requestId, requestRevision: request.requestRevision,
          submissionId: submissionId as HumanSubmissionId, choice: draft.choice, text: draft.text, result: null })
          .catch((reason: unknown) => { setError(String(reason)) }).finally(() => { setPending(false) })
      }}>{t('humanSubmit')}</Button>
    </>}
    <div className={css.row}><Button onClick={open}>{t('open')}</Button>
      <Button disabled={pending || reconcile === undefined} onClick={() => {
        setPending(true); setError('')
        void reconcile?.(request.requestId).catch((reason: unknown) => { setError(String(reason)) }).finally(() => { setPending(false) })
      }}>{t('humanRefresh')}</Button>
      {['pending', 'stopped'].includes(view.phase) && <Button disabled={pending || cancel === undefined} onClick={() => {
        setPending(true); setError('')
        void cancel?.(request.requestId).catch((reason: unknown) => { setError(String(reason)) }).finally(() => { setPending(false) })
      }}>{t('humanCancel')}</Button>}</div>
    {error !== '' && <p role="alert" className={css.text}>{t('error', { message: error })}</p>}
  </article>
}
