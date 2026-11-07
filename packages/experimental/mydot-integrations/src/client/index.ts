/** Web settings contribution for the MyDot semantic-tool Host plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IntegrationCard } from './IntegrationCard.tsx'
import { en, zh, type LocaleKey } from './locales.ts'
import { statusOf } from './status.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MyDot connection and permission handoff copy. */
    'settings.mydotIntegrations': LocaleKey
  }
}

/** Settings entry id; the profile must retain this stable identity. */
export const SETTINGS_ID = 'mydot-integrations'
/** Required browser services. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Observe only the redacted configuration and dispose every subscription on unload.
 * @param ctx - Browser plugin Context.
 */
export function apply(ctx: Context): void {
  const namespace = 'settings.mydotIntegrations'
  const t = ctx.locale.bind(namespace)
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'mydot-integrations: dictionaries')
  const form = ctx.configForms.get<unknown>(SETTINGS_ID)
  const snapshot = form.getSnapshot()
  const store = createSnapshotStore(statusOf(snapshot.status, snapshot.value))
  ctx.effect(() => form.subscribe(() => {
    const next = form.getSnapshot()
    store.set(statusOf(next.status, next.value))
  }), 'mydot-integrations: redacted configuration')
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_ID], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: SETTINGS_ID, order: 30, label: () => t('title'), locale: namespace,
    inject: () => ({ hooks: { integrationStatus: store } }),
  }, IntegrationCard))), 'mydot-integrations: settings card')
}
