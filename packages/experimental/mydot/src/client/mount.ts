/** MyDot Client registration uses the shared Remote carrier and effect-owned slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-experimental-mydot/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ArtifactView } from '../types.ts'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { MyDotDock } from './Dock.tsx'
import { MyDotPanel, MyDotIcon } from './Panel.tsx'
import { createMyDotStore } from './store.ts'
import { createEditorStore } from './editor-store.ts'
import type { Commands, ViewState } from './props.ts'
import { en, zh, ja, NS, type MyDotKey } from './locales.ts'

export const inject = ['remote', 'slots', 'locale', 'uiWorkspace', 'sidebarRight', 'layout']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { mydot: MyDotKey }
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error
  return result.value
}

/** Register one subscribed source and dispose every stream/slot on unload.
 * @param ctx - Client services declared by inject.
 */
export function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'mydot: dictionaries')
  ctx.effect(() => ctx.locale.register(NS, 'ja', ja), 'mydot: Japanese dictionary')
  const source = createSnapshotStore<ViewState>({ phase: 'loading' })
  let preview: ArtifactView | undefined
  const reportDisconnected = (): void => {
    const previous = source.getSnapshot()
    source.set(previous.phase === 'ready' ? { ...previous, disconnected: true } : { phase: 'failed', message: 'unavailable' })
  }
  let stopWatch: (() => void) | undefined
  const watch = (): void => {
    stopWatch?.()
    const controller = new AbortController()
    const stream = ctx.remote.mydot.watch(controller.signal)
    stopWatch = () => { controller.abort(); stream.dispose() }
    void (async () => {
      try {
        for await (const snapshot of stream) {
          if (!controller.signal.aborted) source.set({ phase: 'ready', value: snapshot })
        }
        if (!controller.signal.aborted) reportDisconnected()
      } catch (_error: unknown) {
        if (!controller.signal.aborted) reportDisconnected()
      }
    })()
  }
  ctx.effect(() => { watch(); return () => stopWatch?.() }, 'mydot: shared subscription')
  ctx.on('connection/reset', watch)
  const commands: Commands = {
    hooks: { mydot: source }, retry: watch,
    newRequestId: randomUUID,
    filingCommand: async (command, filing, externalControlsClosed) => {
      if (command === 'reconcile') value(await ctx.remote.mydotFiling.reconcile(filing.plan.caseId))
      else if (command === 'begin') value(await ctx.remote.mydotFiling.begin(filing.plan.caseId, filing.revision, filing.planDigest, externalControlsClosed === true))
      else value(await ctx.remote.mydotFiling[command](filing.plan.caseId, filing.revision, filing.planDigest))
    },
    answerHumanRequest: async (answer) => { value(await ctx.remote.mydotHandoff.answer(answer)) },
    reconcileHumanRequest: async (requestId) => { value(await ctx.remote.mydotHandoff.reconcile(requestId)) },
    cancelHumanRequest: async (requestId) => { value(await ctx.remote.mydotHandoff.cancel(requestId)) },
    presentResults: async (sessionId) => { value(await ctx.remote.mydot.presentResults(sessionId)) },
    releaseDesktop: async (sessionId) => { value(await ctx.remote.mydot.releaseDesktop(sessionId)) },
    saveSpace: async input => value(await ctx.remote.mydot.saveSpace(input)),
    attach: async (sessionId, spaceId) => { value(await ctx.remote.mydot.attach(sessionId, spaceId)) },
    createConversation: async (spaceId) => {
      const created = value(await ctx.remote.mydot.createConversation(spaceId))
      ctx.uiWorkspace.openSession(created.sessionId)
    },
    startJob: async (input) => { value(await ctx.remote.mydot.startJob(input)) },
    send: async (sessionId, input) => {
      if (input.target === null) {
        value(await ctx.remote.session.prompt({ sessionId, requestId: input.requestId, mode: input.delivery, content: [{ type: 'text', text: input.text }] }))
      } else {
        value(await ctx.remote.mydot.send({ parentSessionId: sessionId, childSessionId: input.target,
          requestId: input.requestId, delivery: input.delivery, text: input.text }))
      }
    },
    stop: async (job) => {
      value(await ctx.remote.mydot.stop({ parentSessionId: job.parentSessionId, childSessionId: job.childSessionId }))
    },
    open: (job) => { ctx.uiWorkspace.openSession({ parentSessionId: job.parentSessionId, childSessionId: job.childSessionId,
      mode: job.mode === 'continuable' ? 'continuable' : job.mode === 'one-shot' ? 'one-shot' : 'unknown' }) },
    openConversation: (sessionId) => {
      const snapshot = source.getSnapshot()
      const job = snapshot.phase === 'ready' ? snapshot.value.jobs.find(item => item.childSessionId === sessionId) : undefined
      ctx.uiWorkspace.openSession(job === undefined ? sessionId : { parentSessionId: job.parentSessionId, childSessionId: sessionId, mode: job.mode === 'continuable' ? 'continuable' : 'unknown' })
    },
    preview: (file) => {
      if (ctx.sidebarRight.mounted.getSnapshot() !== file.sessionId) {
        preview = file
        ctx.uiWorkspace.openSession(file.parentSessionId === file.sessionId ? file.sessionId : { parentSessionId: file.parentSessionId, childSessionId: file.sessionId, mode: 'unknown' })
        return
      }
      ctx.sidebarRight.openResource(fileAddressFor(file.sessionId, undefined, file.path))
    },
    flushPreview: (sessionId) => {
      if (preview?.sessionId !== sessionId || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return
      const file = preview
      preview = undefined
      ctx.sidebarRight.openResource(fileAddressFor(sessionId, undefined, file.path))
    },
    readFile: async (sessionId, path) => value(await ctx.remote.mydot.readFile(sessionId, path)),
    saveFile: async (sessionId, edit) => value(await ctx.remote.mydot.saveFile(sessionId, edit)),
    readMemory: async scope => value(await ctx.remote.mydot.readMemory(scope)),
    saveMemory: async (scope, edit) => value(await ctx.remote.mydot.saveMemory(scope, edit)),
    continueFile: async (sessionId, path, version) => {
      value(await ctx.remote.mydot.continueFile(sessionId, path, version, randomUUID() as SessionRequestId))
    },
    handoff: async () => { value(await ctx.remote.mydot.handoffDesktop()) },
    resume: async (owner, capturedAt) => { value(await ctx.remote.mydot.resumeDesktop(owner, capturedAt)) },
  }
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'mydot', locale: NS, store: createMyDotStore, inject: () => commands,
  }, MyDotDock))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'mydot', locale: NS, store: createEditorStore, inject: () => commands,
  }, MyDotPanel))
  const selected = new URL(window.location.href).searchParams.getAll('humanRequest')
  const selectedId = selected.join('')
  if (selected.length === 1 && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(selectedId)) {
    commands.selectedHumanRequestId = selectedId
    ctx.layout.selectPanel('mydot' as MainPanelId)
  }
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'mydot', locale: NS, label: () => t('title') }, MyDotIcon))
}

/** Mount only this opt-in feature's generated Remote contribution.
 * @param ctx - Client services.
 * @param contribution - Generated Host-for-Client contribution.
 * @returns Effect disposer draining registered UI before withdrawing its Remote.
 */
export async function mountMyDot(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const fiber = ctx.inject(['remote.mydot', ...inject], registerUi)
  try { await fiber } catch (error: unknown) { await fiber.dispose(); await disposeRemote(); throw error }
  return async () => { await fiber.dispose(); await disposeRemote() }
}
