// @vitest-environment jsdom
/** Exercise the shipped Client entry with its generated Remote contribution. */
import { expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/client/index.ts'

it('loads the generated Remote and withdraws all registered UI before its contribution', async () => {
  const rt = await SlotTestRuntime.create()
  try {
    const locale = new LocaleRuntime(rt.ctx)
    rt.ctx.provide('locale', locale)
    rt.slots.installLocale(locale)
    rt.ctx.provide('uiWorkspace', {} as never)
    rt.ctx.provide('sidebarRight', {} as never)
    rt.ctx.provide('layout', {} as never)
    const evidence = {
      setTarget: vi.fn(() => { throw new Error('Mounting must not select a verification target') }),
      refresh: vi.fn(() => { throw new Error('Mounting must not fetch CI evidence') }),
    }
    rt.remote.provideNamespaces({
      mydot: { watch: () => ({ async *[Symbol.asyncIterator]() {}, dispose() {} }) },
      mydotEvidence: evidence,
    })
    const withdraw = vi.fn(async () => { expect(rt.slots.entries('main')).toHaveLength(0) })
    const mount = vi.spyOn(rt.remote, '$mount').mockResolvedValue(withdraw)
    await rt.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' }, 'conversation.input.dock': { kind: 'list', scope: 'session' } } as never)
    let dispose: (() => Promise<void>) | undefined
    const plugin = { inject, apply: async (ctx: Context) => {
      dispose = await apply(ctx)
      return dispose
    } }
    await rt.mount(plugin)
    expect(mount).toHaveBeenCalledOnce()
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({ package: '@deepseek-ai/dsh-experimental-mydot' }))
    expect(rt.slots.entries('main')).toHaveLength(1)
    expect(rt.slots.entries('sidebar.panellist')).toHaveLength(1)
    expect(rt.slots.entries('conversation.input.dock')).toHaveLength(1)
    expect(evidence.setTarget).not.toHaveBeenCalled()
    expect(evidence.refresh).not.toHaveBeenCalled()
    await dispose!()
    expect(withdraw).toHaveBeenCalledOnce()
  } finally { await rt.dispose() }
})
