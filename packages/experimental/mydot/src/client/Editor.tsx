/** Versioned document and memory editor with retained conflict drafts. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelProps } from './props.ts'
import type { createEditorStore } from './editor-store.ts'
import css from './MyDot.module.css'

type EditorProps = PanelProps & PropsStore<ReturnType<typeof createEditorStore>>

/** Edit one explicitly opened source while its viewing store retains the draft. */
export function MyDotEditor(props: EditorProps) {
  const { useStore, actions, t } = props
  const editor = useStore(state => state.editor)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (editor === null) return null
  const { sessionId, scope, version, path } = editor
  const dirty = editor.draft !== editor.saved
  const report = (reason: unknown): void => { setError(t('error', { message: String(reason) })) }
  const save = async (): Promise<void> => {
    setPending(true)
    try {
      const request = { path, version, content: editor.draft }
      const result = scope !== null ? await props.saveMemory(scope, request) : await props.saveFile(sessionId, request)
      if (result.kind === 'saved') actions.saved(result.version, result.content)
      else actions.conflict(result.current.kind === 'text' ? result.current.version : null,
        result.current.kind === 'text' ? result.current.content : t('missing'))
    } catch (reason: unknown) { report(reason) } finally { setPending(false) }
  }
  return <section className={css.card} aria-label={t('edit')}>
    <span className={css.text}>{path}</span>
    <textarea aria-label={t('edit')} className={`${css.input} ${css.editor}`} value={editor.draft}
      disabled={pending} onChange={(event) => { actions.draft(event.target.value) }} />
    {dirty && <p role="status">{t('dirty')}</p>}
    {editor.conflict !== null && <><p role="alert">{t('conflict')}</p><pre className={css.text}>{editor.conflict}</pre></>}
    <div className={css.row}>
      <Button disabled={pending || !dirty} onClick={() => { void save() }}>{t('save')}</Button>
      <Button disabled={pending} onClick={() => { actions.discard() }}>{t('discard')}</Button>
      <Button disabled={pending || dirty} onClick={() => {
        const read = scope !== null ? props.readMemory(scope) : props.readFile(sessionId, path)
        void read.then((result) => {
          if (result.kind === 'text') actions.saved(result.version, result.content)
          else report(t('missing'))
        }).catch(report)
      }}>{t('reload')}</Button>
      {sessionId !== null && version !== null && <Button disabled={pending || dirty} onClick={() => {
        void props.continueFile(sessionId, path, version).catch(report)
      }}>{t('continue')}</Button>}
      <Button onClick={() => { try { actions.close() } catch (reason: unknown) { report(reason) } }}>{t('close')}</Button>
    </div>
    {error !== null && <p role="alert">{error}</p>}
  </section>
}
