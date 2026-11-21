/** Public synthetic filing preview mounted only through a shipped dsh profile. */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-mydot'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { filingPlanSchema } from '../../src/filing-state.ts'
export const name = 'mydot-filing-profile-fixture'
export const inject = ['mydotFiling', 'sessionController', 'agents']
/** Isolated public fixture paths and explicitly chosen review lifetime. */
export interface Config { workspace: string; metadataFile: string; validityMs: number }
export const Config: z<Config> = z.object({ workspace: z.string().required(), metadataFile: z.string().required(),
  validityMs: z.number().step(1).min(1).required() })
/** Prepare one public owner card; no recipient confirmation or recording readiness is fabricated.
 * @param ctx - Existing shipped profile services.
 * @param config - Public workspace and metadata destination.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(async () => {
    const previous = (await ctx.mydotFiling.snapshot()).find(card => card.filing.plan.legalEntity === 'Public synthetic corporation')
    if (previous !== undefined) {
      await writeFile(config.metadataFile, JSON.stringify({ sessionId: previous.filing.sessionId, caseId: previous.filing.plan.caseId,
        revision: previous.filing.revision, planDigest: previous.filing.planDigest }))
      return () => undefined
    }
    const { sessionId } = await ctx.sessionController.create({ cwd: config.workspace })
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const caseId = await ctx.mydotFiling.startCase(resolved.agent)
    const files = []
    for (const role of ['source', 'preview', 'attachment'] as const) {
      const content = `Public synthetic ${role}; no private records.\n`
      const path = join(config.workspace, `mock-filing-${role}.txt`)
      await writeFile(path, content)
      files.push({ role, path, digest: createHash('sha256').update(content).digest('hex') })
    }
    const plan = filingPlanSchema.parse({ caseId, legalEntity: 'Public synthetic corporation', account: 'public-mock-account',
      site: 'local-synthetic-recipient', period: { from: '2025-01-01', to: '2025-12-31' }, tax: 'synthetic-tax', destination: 'mock-local',
      amount: '1000', currency: 'JPY', forms: ['public-mock-return'], files, inputDestinations: ['local-preview'], modelDestinations: [],
      expiresAt: Date.now() + config.validityMs, stopRef: 'owner-cancel', queryRef: 'mock-intent-query',
      effects: { submit: true, payment: 'none', standingSettings: 'none' } })
    const filing = await ctx.mydotFiling.prepare(resolved.agent, plan)
    await writeFile(config.metadataFile, JSON.stringify({ sessionId, caseId, revision: filing.revision, planDigest: filing.planDigest }))
    return () => undefined
  })
}
