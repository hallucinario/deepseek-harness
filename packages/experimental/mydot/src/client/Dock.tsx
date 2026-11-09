/** Conversation-local work controls; drafts and exact destination live in the registered store. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { DockProps } from './props.ts'
import type { PendingInput } from './store.ts'
import { MyDotVerification } from './Verification.tsx'
import css from './MyDot.module.css'

/** Render existing child jobs alongside an explicit targeted text composer. */
export function MyDotDock(props: DockProps) {
  const { sessionId, useMydot, useStore, actions, t } = props
  useEffect(() =>{  props.flushPreview(sessionId) }, [props.flushPreview, sessionId])
  const view = useMydot(value => value)
  const draft = useStore(value => value)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { creating, names, requests } = draft
  const jobs = view.phase === 'ready' ? view.value.jobs.filter(job => job.parentSessionId === sessionId) : []
  const selected = draft.target === null ? undefined : jobs.find(job => job.childSessionId === draft.target)
  const destination = selected?.label ?? (draft.target === null ? t('parent') : draft.target)
  const send = async (): Promise<void> => {
    const request: PendingInput = draft.pending ?? { requestId: props.newRequestId() as SubagentPromptRequestId,
      target: draft.target, delivery: draft.delivery, text: draft.text }
    actions.pending(request)
    setSending(true)
    setError(null)
    try { await props.send(sessionId, request); actions.accepted() }
    catch (_error: unknown) { setError(t('uncertain')) }
    finally { setSending(false) }
  }
  return <section className={css.root} data-mydot-dock>
    <Button size="sm" aria-expanded={draft.expanded} onClick={() =>{  actions.expand(!draft.expanded) }}>{t('title')}</Button>
    {draft.expanded && <>
      {view.phase === 'loading' && <p role="status">{t('loading')}</p>}
      {view.phase === 'failed' && <p role="alert">{t('failed')} <Button onClick={props.retry}>{t('retry')}</Button></p>}
      {view.phase === 'ready' && <>
        {view.value.issues?.filter(issue => issue.sessionId === sessionId).map(issue => <p role="alert" key={issue.kind}>{t(issue.kind === 'artifact-delivery' ? 'deliveryFailed' : 'sourceFailed')} <Button onClick={() => { void props.presentResults(sessionId).catch(() =>{  setError(t('deliveryFailed')) }) }}>{t('retry')}</Button></p>)}
        {view.disconnected && <p role="alert">{t('failed')} <Button onClick={props.retry}>{t('retry')}</Button></p>}
        <div className={css.row}><strong>{view.value.spaces.find(space => space.id === view.value.conversations.find(item => item.sessionId === sessionId)?.spaceId)?.name ?? t('none')}</strong>
          <Button size="sm" onClick={() =>{  actions.creating(!creating) }}>{t('startJobs')}</Button>
        </div>
        {creating && <div className={css.card}>
          {[0, 1].map(index => <div className={css.field} key={index}>
            <label>{t(index === 0 ? 'labelA' : 'labelB')}<input className={css.input} disabled={sending || draft.starts !== null} value={names[index]} onChange={(event) =>{  actions.name(index, event.target.value) }} /></label>
            <label>{t(index === 0 ? 'requestA' : 'requestB')}<textarea className={css.input} disabled={sending || draft.starts !== null} value={requests[index]} onChange={(event) =>{  actions.request(index, event.target.value) }} /></label>
          </div>)}
          <Button disabled={sending || names.some(name => name.trim() === '') || requests.some(request => request.trim() === '')} onClick={() => {
            const starts = draft.starts ?? ([0, 1] as const).map(index => ({ parentSessionId: sessionId,
              requestId: props.newRequestId() as SessionRequestId, label: names[index], prompt: requests[index], provider: 'spawn' as const }))
            actions.starting(starts)
            setSending(true)
            void Promise.all(starts.map(input => props.startJob(input)))
              .then(() =>{  actions.started() })
              .catch((reason: unknown) =>{  setError(t('error', { message: String(reason) })) })
              .finally(() =>{  setSending(false) })
          }}>{t('startJobs')}</Button>
        </div>}
        <div className={css.jobs}>{jobs.map(job => <article className={css.card} key={job.childSessionId}>
          <strong>{job.label}</strong>{job.request && <p className={css.text}>{job.request}</p>}{job.summary && <p className={css.text}>{job.summary}</p>}<span>{t(job.status === 'running' ? 'running' : 'inactive')}</span>
          {draft.stopping[job.childSessionId] && <p role="status">{t(job.status === 'running' ? 'stopping' : 'stopped')}</p>}
          <div className={css.row}>
            <Button size="sm" onClick={() =>{  props.open(job) }}>{t('details')}</Button>
            {job.mode === 'continuable' && <Button size="sm" disabled={job.status !== 'running'} onClick={() => {
              void props.stop(job).then(() =>{  actions.stopping(job.childSessionId) }).catch((reason: unknown) =>{  setError(t('error', { message: String(reason) })) })
            }}>{t('stop')}</Button>}
          </div>
          <MyDotVerification sessionId={job.childSessionId} verification={job.verification} checks={view.value.verificationChecks ?? []}
            disabled={view.disconnected === true} setVerificationTarget={props.setVerificationTarget}
            refreshVerification={props.refreshVerification}
            openConversation={props.openConversation} t={t} />
        </article>)}</div>
        {jobs.length > 0 && <p className={css.muted}>{t('unverified')}</p>}
        <label className={css.field}>{t('destination', { name: destination })}
          <select aria-label={t('destination', { name: destination })} className={css.input} value={draft.target ?? ''}
            disabled={draft.pending !== null || sending} onChange={(event) =>{  actions.target(event.target.value === '' ? null : event.target.value as typeof sessionId) }}>
            <option value="">{t('parent')}</option>
            {jobs.filter(job => job.mode === 'continuable').map(job => <option value={job.childSessionId} key={job.childSessionId}>{job.label}</option>)}
          </select>
        </label>
        <select aria-label={t('method')} className={css.input} value={draft.delivery} disabled={draft.pending !== null || sending}
          onChange={(event) =>{  actions.delivery(event.target.value === 'steer' ? 'steer' : 'queue') }}>
          <option value="steer">{t('steer')}</option><option value="queue">{t('queue')}</option>
        </select>
        <textarea aria-label={t('send')} className={css.input} value={draft.text} disabled={sending || draft.pending !== null}
          onChange={(event) =>{  actions.text(event.target.value) }} />
        <div className={css.row}><Button disabled={sending || (draft.pending === null && draft.text.trim() === '') || (draft.target !== null && selected === undefined)}
          onClick={() => { void send() }}>{t(draft.pending === null ? 'send' : 'retry')}</Button></div>
        {draft.receipt && <p role="status">{t('accepted')}</p>}
        <div className={css.row}>{view.value.artifacts
          .filter(file => file.parentSessionId === sessionId || file.sessionId === sessionId).map(file =>
            <Button key={`${file.sessionId}:${file.path}`} disabled={!file.available} onClick={() =>{  props.preview(file) }}>{file.available ? file.path : `${file.path} · ${t('missing')}`}</Button>)}</div>
      </>}
      {error !== null && <p role="alert">{error}</p>}
    </>}
  </section>
}
