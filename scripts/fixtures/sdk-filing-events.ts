/** Synthetic filing payloads for SDK transport coverage; performs no filing or recording. */
import { createHash, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { FilingCaseId, FilingView, MockReceipt } from '@deepseek-ai/dsh-experimental-mydot/types'

export const name = 'snapshot-filing-events'

/**
 * Append the three filing event payloads to the root turn without changing model history.
 * @param ctx - The SDK profile's existing event context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    const messages = JSON.stringify(agent.session.deriveMessages())
    const caseId = randomBytes(16).toString('hex') as FilingCaseId
    const view: FilingView = {
      sessionId: agent.id,
      plan: {
        caseId,
        legalEntity: 'Public SDK fixture corporation',
        account: 'public-mock-account',
        site: 'local-synthetic-recipient',
        period: { from: '2025-01-01', to: '2025-12-31' },
        tax: 'synthetic-tax',
        destination: 'mock-local',
        amount: '1000',
        currency: 'JPY',
        forms: ['public-mock-return'],
        files: [
          { role: 'source', path: 'public-source.txt', digest: createHash('sha256').update('Public synthetic SDK source.\n').digest('hex') },
          { role: 'preview', path: 'public-preview.txt', digest: createHash('sha256').update('Public synthetic SDK preview.\n').digest('hex') },
        ],
        inputDestinations: ['local-preview'],
        modelDestinations: [],
        expiresAt: 4102444800000,
        stopRef: 'owner-cancel',
        queryRef: 'mock-intent-query',
        effects: { submit: true, payment: 'none', standingSettings: 'none' },
      },
      revision: 1,
      planDigest: '',
      phase: 'prepared',
      actor: 'model-preparer',
      control: 'agent',
    }
    view.planDigest = createHash('sha256').update(JSON.stringify(view.plan)).digest('hex')
    const receipt: MockReceipt = {
      caseId,
      planDigest: view.planDigest,
      intentId: randomBytes(16).toString('hex'),
      receiptId: randomBytes(16).toString('hex'),
      forms: view.plan.forms,
    }
    agent.session.append('mydot/filing-case', { caseId, sessionId: agent.id })
    agent.session.append('mydot/filing', { view })
    agent.session.append('mydot/mock-receipt', receipt)
    if (JSON.stringify(agent.session.deriveMessages()) !== messages) {
      throw new Error('SDK filing transport fixtures changed model-visible messages')
    }
  })
}
