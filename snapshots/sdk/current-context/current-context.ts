/** Current-only context exercised through the shipped SDK profile. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Session } from '@deepseek-ai/dsh-session'

/** Cordis fixture identity. */
export const name = 'current-context-fixture'
/** Services used to publish a current contribution and observe work starts. */
export const inject = ['agents', 'systemPrompt']

/**
 * Publish a different experience for each admitted root turn.
 * @param ctx - fixture lifetime and scoped service access.
 */
export function apply(ctx: Context): void {
  const text = new WeakMap<Session, string>()
  ctx.systemPrompt.context({
    name: 'current-context-fixture:experience',
    order: 600,
    retention: 'current',
    interpolate: false,
    text: context => context.agent === undefined ? '' : text.get(context.agent.session) ?? '',
  })
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    text.set(agent.session, turn === 1 ? 'Experience for work A: inspect alpha.ts.' : 'Experience for work B: inspect beta.ts.')
    return next()
  })
}
