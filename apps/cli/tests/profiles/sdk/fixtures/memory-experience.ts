/** Human command acceptance inside the real SDK-profile memory composition. */
import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-experimental-memory-experience'

/** Cordis fixture identity. */
export const name = 'memory-experience-acceptance'
/** Human controls and their memory owner must already be active. */
export const inject = ['agents', 'commands', 'experienceMemory']

/** Output file owned by the acceptance test. */
export interface Config {
  /** Absolute private file receiving command results. */
  reportPath: string
}

/** Validate the Loader-owned output path. */
export const Config: z<Config> = z.object({ reportPath: z.string().required() })

/**
 * Inspect and retire the first session's experience before a later task starts.
 * @param ctx - fixture lifecycle and services.
 * @param config - test-owned command-result destination.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.id !== 'memory-retire') return
    await ctx.experienceMemory.flush()
    const records = await ctx.experienceMemory.list(agent)
    const first = records.find(record => record.sessionId === 'memory-source')
    if (first === undefined) throw new Error('memory acceptance: source episode was not captured')
    const signal = new AbortController().signal
    const commands = []
    for (const input of ['status', 'list', `inspect ${first.id}`, `retire ${first.id}`]) {
      const result = await ctx.commands.execute(agent, `/memory-experience ${input}`, [], signal)
      if (result?.result.kind !== 'success') throw new Error(`memory acceptance command failed: ${input}`)
      commands.push({ input, result: result.result })
    }
    await writeFile(config.reportPath, JSON.stringify({ id: first.id, commands }))
  })
}
