// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { IntegrationCard, type IntegrationCardProps } from '../src/client/IntegrationCard.tsx'
import { en } from '../src/client/locales.ts'
import { statusOf } from '../src/client/status.ts'

afterEach(cleanup)

describe('MyDot permission console card', () => {
  it('shows readiness accurately and links to separate authentication without credentials', () => {
    const state = statusOf('ready', { brokerUrl: 'https://broker.example/', executorTokenFile: '/private/executor.token', token: 'secret' })
    expect(state).toEqual({ status: 'ready', consoleUrl: 'https://broker.example/admin' })
    const store = createSnapshotStore(state)
    const props: IntegrationCardProps = { view: 'page', t: makeTranslate(en), useIntegrationStatus: bindSnapshotSelector(store) }
    render(<IntegrationCard {...props} />)
    expect(screen.getByRole('status').textContent).toBe(en.configured)
    expect(screen.getByRole('link', { name: en.openConsole }).getAttribute('href')).toBe('https://broker.example/admin')
    expect(screen.getByRole('link').getAttribute('rel')).toBe('noopener noreferrer')
    expect(document.body.textContent).toContain('drafts only')
    expect(document.body.textContent).not.toContain('/private/')
    expect(document.body.textContent).not.toContain('secret')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it.each(['javascript:alert(1)', 'https://user:token@example.com', 'http://remote.example', 'https://broker.example/?token=secret', 'https://broker.example/#token'])('does not link to unsafe origin %s', (brokerUrl) => {
    expect(statusOf('ready', { brokerUrl })).toEqual({ status: 'ready' })
  })

  it('keeps incomplete configuration unavailable and emits only a summary in summary view', () => {
    expect(statusOf('loading', { brokerUrl: 'https://broker.example' })).toEqual({ status: 'loading' })
    expect(statusOf('ready', null)).toEqual({ status: 'ready' })
    const store = createSnapshotStore(statusOf('unavailable', undefined))
    const props: IntegrationCardProps = { view: 'summary', t: makeTranslate(en), useIntegrationStatus: bindSnapshotSelector(store) }
    render(<IntegrationCard {...props} />)
    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
