/** User-selected CI targets and persisted observations; execution state is not a verdict. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { VerificationCheck, VerificationHistory, VerificationReason, VerificationTarget, VerificationView } from '../types.ts'
import type { Commands } from './props.ts'
import type { MyDotKey, NS } from './locales.ts'
import css from './MyDot.module.css'

type VerificationProps = PropsLocale<typeof NS> & Pick<Commands, 'setVerificationTarget' | 'refreshVerification' | 'openConversation'> & {
  sessionId: SessionId
  /** Absent when the Host has not enabled evidence for this job. */
  verification: VerificationView | undefined
  checks: readonly VerificationCheck[]
  disabled: boolean
}

const statusKeys = {
  unobserved: 'verificationUnobserved', passed: 'verificationPassed', failed: 'verificationFailed', unavailable: 'verificationUnavailable',
} satisfies Record<VerificationView['status'], MyDotKey>

const reasonKeys = {
  'condition-passed': 'verificationReasonPassed', 'condition-failed': 'verificationReasonFailed',
  'job-not-completed': 'verificationReasonPending', 'job-not-passed': 'verificationReasonNotPassed',
  'job-missing': 'verificationReasonMissing', 'job-ambiguous': 'verificationReasonAmbiguous',
  'run-mismatch': 'verificationReasonMismatch', 'unsupported-event': 'verificationReasonEvent',
  'workflow-changed': 'verificationReasonWorkflow', 'attempt-changed': 'verificationReasonAttempt',
  'provider-unavailable': 'verificationReasonProviderUnavailable', 'invalid-response': 'verificationReasonInvalid',
  cancelled: 'verificationReasonCancelled',
} satisfies Record<VerificationReason, MyDotKey>

function TargetDetails({ target, t }: PropsLocale<typeof NS> & { target: VerificationTarget }) {
  return <dl className={css.evidenceFacts}>
    <dt>{t('verificationRequest')}</dt><dd className={css.text}>{t('verificationMessage', { seq: target.request.seq })}<p>{target.request.text}</p></dd>
    <dt>{t('verificationRepository')}</dt><dd className={css.text}>{target.check.repository}</dd>
    <dt>{t('verificationCommit')}</dt><dd className={css.text}><code>{target.commit}</code></dd>
    <dt>{t('verificationCondition')}</dt><dd className={css.text}>{target.check.description}<p>{target.check.jobName}</p></dd>
    <dt>{t('verificationConditionVersion')}</dt><dd className={css.text}><code>{target.check.id} · {target.checkRevision}</code></dd>
    <dt>{t('verificationWorkflow')}</dt><dd className={css.text}><code>{target.check.workflowPath}@{target.check.workflowFileSha}</code></dd>
  </dl>
}

function Observation({ entry, t }: PropsLocale<typeof NS> & { entry: VerificationHistory }) {
  const { observation, target, current } = entry
  return <article className={css.card} data-verification-current={current}>
    <strong>{t(current ? 'verificationCurrent' : 'verificationHistorical')}</strong>
    <span>{t(statusKeys[observation.outcome])}</span>
    <p>{t(reasonKeys[observation.reason])}</p>
    <div className={css.row}><span>{t('verificationObservedAt')}</span><time dateTime={new Date(observation.observedAt).toISOString()}>{new Date(observation.observedAt).toISOString()}</time></div>
    <TargetDetails target={target} t={t} />
    {observation.run !== undefined && <p>{t('verificationEvent')} · <code>{observation.run.event}</code></p>}
    <div className={css.row}>
      {observation.run !== undefined && <a href={observation.run.url} target="_blank" rel="noopener noreferrer">{t('verificationRun', { id: observation.run.id, attempt: observation.run.attempt })}</a>}
      {observation.job !== undefined && <a href={observation.job.url} target="_blank" rel="noopener noreferrer">{t('verificationJob', { name: observation.job.name, id: observation.job.id })}</a>}
    </div>
  </article>
}

/** Render opt-in evidence without creating checks, polling, or accepting model verdicts.
 * @param props - The job's Host projection, configured conditions and explicit commands.
 * @returns A scoped condition summary and user-operated target and history controls.
 */
export function MyDotVerification(props: VerificationProps) {
  const { verification, checks, sessionId, disabled, t } = props
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<{ request: string; check: string; commit: string } | null>(null)
  const [run, setRun] = useState('')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  if (verification === undefined) return null
  const target = verification.target
  const requestSelection = draft === null ? String(target?.request.seq ?? verification.requests[0]?.seq ?? '') : draft.request
  const checkSelection = draft === null ? target?.check.id ?? checks[0]?.id ?? '' : draft.check
  const commitSelection = draft === null ? target?.commit ?? '' : draft.commit
  const selectedRequest = verification.requests.find(request => String(request.seq) === requestSelection)
  const selectedCheck = checks.find(check => check.id === checkSelection)
  const blocked = disabled || pending
  const runId = /^[1-9]\d*$/.test(run) ? Number(run) : NaN
  const binding = selectedRequest === undefined || selectedCheck === undefined ? null
    : { requestSeq: selectedRequest.seq, checkId: selectedCheck.id, commit: commitSelection.trim().toLowerCase() }
  const canBind = !blocked && binding !== null && /^[0-9a-f]{40}$/i.test(binding.commit)
  const canRead = !blocked && target !== null && verification.definitionCurrent && Number.isSafeInteger(runId)
  const edit = (change: Partial<NonNullable<typeof draft>>): void => {
    setDraft({ request: requestSelection, check: checkSelection, commit: commitSelection, ...change })
    setFailed(false)
  }
  const perform = async (command: () => Promise<void>): Promise<void> => {
    setPending(true)
    setFailed(false)
    try { await command() }
    catch (_error: unknown) { setFailed(true) }
    finally { setPending(false) }
  }
  return <section className={css.evidence} aria-label={t('verificationTitle')}>
    <strong>{t('verificationTitle')}</strong>
    <p role="status">{t(!verification.definitionCurrent && target !== null ? 'verificationDefinitionChanged' : statusKeys[verification.status])}</p>
    {target !== null && <div className={css.text}>
      <span>{target.check.repository} · {target.check.jobName}</span>
      <p>{t('verificationCommit')} · <code>{target.commit}</code></p>
    </div>}
    <Button size="sm" aria-expanded={expanded} onClick={() => { setExpanded(value => !value) }}>{t('verificationDetails')}</Button>
    {expanded && <>
      <p className={css.muted}>{t('verificationScope')}</p>
      {verification.invalidRecords && <p role="alert">{t('verificationInvalidRecords')}</p>}
      {target !== null && <TargetDetails target={target} t={t} />}
      <Button size="sm" onClick={() => { props.openConversation(sessionId) }}>{t('verificationOpenRequest')}</Button>
      <div className={css.card}>
        <label className={css.field}>{t('verificationRequest')}<select className={css.input} value={requestSelection} disabled={blocked || verification.requests.length === 0}
          onChange={(event) => { edit({ request: event.target.value }) }}>
          {verification.requests.map(request => <option key={request.seq} value={request.seq}>{t('verificationMessage', { seq: request.seq })} · {request.text}</option>)}
        </select></label>
        {verification.requests.length === 0 && <p>{t('verificationNoRequests')}</p>}
        <label className={css.field}>{t('verificationCondition')}<select className={css.input} value={checkSelection} disabled={blocked || checks.length === 0}
          onChange={(event) => { edit({ check: event.target.value }) }}>
          {selectedCheck === undefined && target !== null && <option value={target.check.id} disabled>{target.check.description}</option>}
          {checks.map(check => <option key={check.id} value={check.id}>{check.description} · {check.repository} · {check.jobName}</option>)}
        </select></label>
        <label className={css.field}>{t('verificationCommit')}<input className={css.input} value={commitSelection} disabled={blocked} autoComplete="off" spellCheck={false}
          onChange={(event) => { edit({ commit: event.target.value }) }} /></label>
        <Button size="sm" disabled={!canBind} onClick={binding === null ? undefined : () => {
          void perform(() => props.setVerificationTarget(sessionId, binding))
        }}>{t('verificationSetTarget')}</Button>
      </div>
      {target !== null && <div className={css.card}>
        <label className={css.field}>{t('verificationRunId')}<input className={css.input} value={run} inputMode="numeric" autoComplete="off" disabled={blocked}
          onChange={(event) => { setRun(event.target.value.trim()); setFailed(false) }} /></label>
        <p className={css.muted}>{t('verificationReadHint')}</p>
        <Button size="sm" disabled={!canRead} onClick={() => { void perform(() => props.refreshVerification(sessionId, target.seq, runId)) }}>{t('verificationRead')}</Button>
      </div>}
      {failed && <p role="alert">{t('verificationOperationFailed')}</p>}
      {verification.history.length > 0 && <details><summary>{t('verificationHistory')}</summary><div className={css.evidence}>
        {verification.history.map(entry => <Observation key={entry.observation.seq} entry={entry} t={t} />)}
      </div></details>}
    </>}
  </section>
}
