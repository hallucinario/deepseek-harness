/** Space management and source-linked global work/artifact lists. */
import { useId, useState } from 'react'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import { Button, IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { Space, SpaceId, SpaceInput } from '../types.ts'
import type { PanelProps } from './props.ts'
import { MyDotEditor } from './Editor.tsx'
import { createEditorStore } from './editor-store.ts'
import { HumanRequestCard } from './HumanRequest.tsx'
import type { NS } from './locales.ts'
import css from './MyDot.module.css'

type GlobalProps = PanelProps & PropsStore<ReturnType<typeof createEditorStore>>
type WorkspaceProps = PropsLocale<typeof NS> & Pick<PanelProps, 'useWorkspaces'> & {
  workspaceId: WorkspaceId | undefined
  onChange?: (id: WorkspaceId | undefined) => void
  disabled?: boolean
}

/** Select only registered execution directories; retain unavailable saved associations. */
function SpaceWorkspace({ workspaceId, onChange, disabled, useWorkspaces, t }: WorkspaceProps) {
  const snapshot = useWorkspaces(value => value)
  const noticeId = useId()
  const selected = snapshot.items.find(item => item.workspaceId === workspaceId)
  const unavailable = workspaceId !== undefined && selected === undefined
  const label = selected === undefined
    ? t(workspaceId === undefined ? 'workspaceNone' : snapshot.phase === 'pending' ? 'workspaceLoading' : 'workspaceUnavailable')
    : `${workspaceDisplayTitle(selected.title, t('workspaceDefault'))} · ${selected.path}`
  if (onChange === undefined) return <p className={css.text}>{label}</p>
  const notice = snapshot.state === 'error' ? 'workspaceFailed'
    : snapshot.phase === 'pending' ? 'workspaceLoading' : snapshot.items.length === 0 ? 'workspaceEmpty' : undefined
  return <>
    <label className={css.field}>{t('workspace')}<select className={css.input} value={workspaceId ?? ''}
      disabled={disabled || snapshot.phase === 'pending' || snapshot.state === 'error'}
      aria-describedby={notice === undefined ? undefined : noticeId}
      onChange={(event) => {
        if (event.target.value === '') { onChange(undefined); return }
        const workspace = snapshot.items.find(item => item.workspaceId === event.target.value)
        if (workspace !== undefined) onChange(workspace.workspaceId)
      }}>
      <option value="">{t('workspaceNone')}</option>
      {unavailable && <option value={workspaceId} disabled>{label}</option>}
      {snapshot.items.map(item => <option key={item.workspaceId} value={item.workspaceId}>
        {workspaceDisplayTitle(item.title, t('workspaceDefault'))} · {item.path}
      </option>)}
    </select></label>
    {notice !== undefined && <p id={noticeId} role={snapshot.state === 'error' ? 'alert' : 'status'}>{t(notice)}</p>}
  </>
}

type FormProps = PropsLocale<typeof NS> & Pick<PanelProps, 'useWorkspaces'> & {
  space: Space | undefined
  save: (input: SpaceInput) => Promise<Space>
  onError: (message: string) => void
}

function SpaceForm({ space, save, t, onError, useWorkspaces }: FormProps) {
  const [draft, setDraft] = useState<SpaceInput>(space ?? { name: '', purpose: '', instructions: '', materials: [] })
  const [pending, setPending] = useState(false)
  return <div className={css.card}>
    {(['name', 'purpose', 'instructions'] as const).map(field => <label className={css.field} key={field}>{t(field)}
      <textarea className={css.input} value={draft[field]}
        onChange={(event) =>{  setDraft(value => ({ ...value, [field]: event.target.value })) }} />
    </label>)}
    <label className={css.field}>{t('materials')}<textarea className={css.input} value={draft.materials.join('\n')}
      onChange={(event) =>{  setDraft(value => ({ ...value, materials: event.target.value.split('\n').map(path => path.trim()).filter(Boolean) })) }} /></label>
    <SpaceWorkspace workspaceId={draft.workspaceId} useWorkspaces={useWorkspaces} t={t} disabled={pending}
      onChange={(workspaceId) => { setDraft(value => ({ ...value, workspaceId })) }} />
    <div className={css.row}>
      <Button disabled={pending || draft.name.trim() === ''} onClick={() => {
        setPending(true)
        void save(draft).then(setDraft).catch((error: unknown) =>{  onError(String(error)) }).finally(() =>{  setPending(false) })
      }}>{t(space === undefined ? 'create' : 'save')}</Button>
      {space !== undefined && <Button disabled={pending || space.archived} onClick={() => {
        setPending(true)
        void save({ ...draft, archived: true }).then(setDraft)
          .catch((error: unknown) =>{  onError(String(error)) }).finally(() =>{  setPending(false) })
      }}>{t('archive')}</Button>}
    </div>
  </div>
}

/** Reuse the sidebar's standard icon; no new artwork is introduced. */
export function MyDotIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconFolderOpenOutlineRegular size={size} /> }

/** Render global lists and the explicit text/memory editor. */
export function MyDotPanel(props: GlobalProps) {
  const { useMydot, useStore, actions, t } = props
  const view = useMydot(value => value)
  const state = useStore(value => value)
  const [error, setError] = useState<string | null>(null)
  const report = (reason: unknown): void =>{  setError(t('error', { message: String(reason) })) }
  if (view.phase === 'loading') return <p role="status" className={css.root}>{t('loading')}</p>
  if (view.phase === 'failed') return <div className={css.root}><p role="alert">{t('failed')}</p><Button onClick={props.retry}>{t('retry')}</Button></div>
  const data = view.value
  const desktopOwner = data.desktop.owner
  const captureTime = data.desktop.capturedAt
  const humanRequests = data.humanRequests ?? []
  const space = data.spaces.find(item => item.id === state.spaceId)
  const conversations = data.conversations.filter(item => state.spaceId === null || item.spaceId === state.spaceId)
  const parentIds = new Set(conversations.map(item => item.sessionId))
  const readMemory = (scope: Parameters<typeof props.readMemory>[0]): void => {
    void props.readMemory(scope).then((file) => {
      actions.open({ sessionId: null, scope, path: file.path, version: file.kind === 'text' ? file.version : null,
        saved: file.kind === 'text' ? file.content : '', draft: file.kind === 'text' ? file.content : '', conflict: null })
    }).catch(report)
  }
  return <main className={`${css.root} ${css.panel}`} data-mydot-panel>
    <h1 className={css.heading}>{t('title')}</h1>
    {humanRequests.length > 0 && <section className={css.humanRequests}>
      <h2 className={css.heading}>{t('humanRequests')}</h2>
      {[...humanRequests].sort((left, right) => Number(right.request.requestId === props.selectedHumanRequestId)
        - Number(left.request.requestId === props.selectedHumanRequestId))
        .map((view) => {
          const key = `${view.request.requestId}:${view.request.requestRevision}`
          return <HumanRequestCard key={key} view={view} draft={state.humanDrafts?.[key] ?? { choice: '', text: '', submissionId: '' }}
            change={(draft) => { actions.humanDraft(key, draft) }} answer={props.answerHumanRequest} reconcile={props.reconcileHumanRequest}
            cancel={props.cancelHumanRequest}
            mint={props.newRequestId} selected={view.request.requestId === props.selectedHumanRequestId} t={t}
            open={() => { props.openConversation(view.request.sessionId) }} />
        })}
    </section>}
    {view.disconnected && <p role="alert">{t('failed')} <Button onClick={props.retry}>{t('retry')}</Button></p>}
    <label>{t('spaces')}<select className={css.input} value={state.spaceId ?? ''} onChange={(event) =>{  actions.select(event.target.value === '' ? null : event.target.value as SpaceId) }}>
      <option value="">{t('newSpace')}</option>{data.spaces.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ` · ${t('archived')}` : ''}</option>)}
    </select></label>
    <SpaceForm key={space?.id ?? 'new'} space={space} save={props.saveSpace} t={t} onError={report} useWorkspaces={props.useWorkspaces} />
    {space !== undefined && <div className={css.card}>
      <p className={css.text}>{space.purpose}</p><p className={css.text}>{space.instructions}</p>
      <SpaceWorkspace workspaceId={space.workspaceId} useWorkspaces={props.useWorkspaces} t={t} /><p className={css.text}>{space.materials.join('\n')}</p>
      <Button disabled={space.archived} onClick={() => { void props.createConversation(space.id).catch(report) }}>{t('start')}</Button>
    </div>}
    {conversations.map(conversation => <Button key={conversation.sessionId}
      onClick={() =>{  props.openConversation(conversation.sessionId) }}>{conversation.sessionId} · {conversation.cwd}</Button>)}
    <h2 className={css.heading}>{t('jobs')}</h2>
    {data.jobs.filter(job => parentIds.has(job.parentSessionId)).map(job => <article className={css.card} key={job.childSessionId}>
      <strong>{job.label}</strong><span>{t(job.status === 'running' ? 'running' : 'inactive')}</span>
      <Button onClick={() =>{  props.open(job) }}>{t('open')}</Button>
    </article>)}
    <h2 className={css.heading}>{t('artifacts')}</h2>
    {data.artifacts.filter(file => parentIds.has(file.sessionId)).map(file => <article className={css.card} key={`${file.sessionId}:${file.path}`}>
      <span className={css.text}>{file.path}</span><span>{t(file.available ? 'current' : 'missing')}</span>
      <div className={css.row}><Button onClick={() =>{  props.openConversation(file.sessionId) }}>{t('open')}</Button>
        <Button disabled={!file.available} onClick={() =>{  props.preview(file) }}>{t('preview')}</Button>
        <Button disabled={!file.available} onClick={() => { void props.readFile(file.sessionId, file.path).then((read) => {
          actions.open({ sessionId: file.sessionId, scope: null, path: read.path, version: read.kind === 'text' ? read.version : null,
            saved: read.kind === 'text' ? read.content : '', draft: read.kind === 'text' ? read.content : '', conflict: null })
        }).catch(report) }}>{t('edit')}</Button></div>
    </article>)}
    <div className={css.row}><Button onClick={() =>{  readMemory({ kind: 'personal' }) }}>{t('personal')}</Button>
      {space !== undefined && <Button onClick={() =>{  readMemory({ kind: 'space', spaceId: space.id }) }}>{t('scoped')}</Button>}</div>
    <MyDotEditor {...props} />
    <section className={css.card}><h2 className={css.heading}>{t('desktop')}</h2>
      <span>{data.desktop.owner ?? t('none')}</span><span>{data.desktop.capturedAt === undefined ? t('fresh') : new Date(data.desktop.capturedAt).toISOString()}</span>
      <span>{t(data.desktop.phase === 'human' ? 'human' : data.desktop.phase === 'stopping' ? 'desktopStopping' : data.desktop.phase === 'agent' ? 'desktopAgent' : 'desktopFree')}</span>
      {!data.desktopEnabled && <p>{t('desktopDisabled')}</p>}
      {desktopOwner !== undefined && <Button onClick={() =>{  props.openConversation(desktopOwner) }}>{t('screen')}</Button>}
      {data.desktop.phase === 'agent' && desktopOwner !== undefined && <Button disabled={data.desktop.inFlight !== 0}
        onClick={() => { void props.releaseDesktop(desktopOwner).catch(report) }}>{t('release')}</Button>}
      <Button disabled={!data.desktopEnabled || data.desktop.owner === undefined} onClick={() => { void props.handoff().catch(report) }}>{t('handoff')}</Button>
      {desktopOwner !== undefined && captureTime !== undefined && <Button disabled={data.desktop.phase !== 'human'} onClick={() => {
        void props.resume(desktopOwner, captureTime).catch(report)
      }}>{t('resume')}</Button>}
    </section>
    <p>{t('schedules')}</p>
    {error !== null && <p role="alert">{error}</p>}
  </main>
}
