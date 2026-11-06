/** Read-only status and handoff to the independently authenticated broker console. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { IntegrationStatus } from './status.ts'

/** Registration-side snapshot injection, with no secret fields. */
export interface IntegrationCardFace {
  hooks: { integrationStatus: SnapshotStore<IntegrationStatus> }
}

/** Slot-bound properties for the settings card. */
export type IntegrationCardProps = Pick<PropsRuntime<'plugins.item'>, 'view'> & PropsLocale<'settings.mydotIntegrations'> & InjectFace<IntegrationCardFace>

/**
 * Render configuration readiness without claiming provider connectivity.
 * @param props - Slot view, locale and redacted state.
 * @returns A summary or the read-only connection card.
 */
export function IntegrationCard(props: IntegrationCardProps) {
  const { t } = props
  const state = props.useIntegrationStatus(value => value)
  if (props.view === 'summary') return t('description')
  return <section aria-label={t('title')}>
    <p role="status">{t(state.status === 'loading' ? 'loading' : state.consoleUrl === undefined ? 'unavailable' : 'configured')}</p>
    <p>{t('permission')}</p>
    <p>{t('noSend')}</p>
    {state.consoleUrl !== undefined && <p><a href={state.consoleUrl} target="_blank" rel="noopener noreferrer">{t('openConsole')}</a></p>}
    <p>{t('separateLogin')}</p>
  </section>
}
