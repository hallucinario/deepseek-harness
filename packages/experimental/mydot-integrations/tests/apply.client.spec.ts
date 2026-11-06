import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, SETTINGS_ID } from '../src/client/index.ts'
import type { IntegrationCardFace } from '../src/client/IntegrationCard.tsx'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

async function bench(served: boolean) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SlotRegistry)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const describeSettings = vi.fn(() => Promise.resolve({ ok: true, value: {
    writable: false, hasDocument: true, namespaces: served ? [{ ns: SETTINGS_ID,
      schema: Schema.object({ brokerUrl: Schema.string() }).toJSON(),
      value: { brokerUrl: 'https://broker.example' }, applies: 'restart', secrets: ['executorTokenFile'], revision: 0 }] : [],
  } }))
  new TestRemote(ctx, { settings: { describe: describeSettings } })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply })
  const slots = ctx.slots
  slots.register({ name: 'root', children: { 'plugins.item': { kind: 'list', scope: 'root' } } } as never, () => null)
  return { ctx, slots, describeSettings }
}

describe('MyDot settings-card lifecycle', () => {
  it('uses only redacted settings and removes its card on unload', async () => {
    const { ctx, slots } = await bench(true)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber
    await vi.waitFor(() => { expect(slots.entries('plugins.item')).toHaveLength(1) })
    const entry = slots.entries('plugins.item')[0]!
    expect(resolveSlotLabel(entry.options.label)).toBe('MyDot calendar and Outlook')
    const face = (entry.inject as () => Pick<IntegrationCardFace, 'hooks'>)()
    expect(Object.keys(face.hooks)).toEqual(['integrationStatus'])
    await vi.waitFor(() => { expect(face.hooks.integrationStatus.getSnapshot()).toEqual({ status: 'ready', consoleUrl: 'https://broker.example/admin' }) })
    await fiber.dispose()
    expect(slots.entries('plugins.item')).toHaveLength(0)
    await ctx.plugin({ inject: [...inject], apply })
    expect(slots.entries('plugins.item')).toHaveLength(1)
  })

  it('does not show a card when the Host does not serve the plugin', async () => {
    const { ctx, slots, describeSettings } = await bench(false)
    await ctx.plugin({ inject: [...inject], apply })
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    expect(slots.entries('plugins.item')).toHaveLength(0)
  })
})
