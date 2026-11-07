/** Parent inbox presentation of source-linked child deliverables. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-tool-present/types'

/** Present each child's own declaration once in the live parent's durable inbox.
 * @param ctx - Existing Session observation, live Agent and file services.
 * @param parentId - Durable direct parent established by the subagent catalog.
 * @param childId - Cataloged local child; inherited fork declarations are excluded.
 * @returns Number of newly accepted parent messages; no claim of result verification.
 */
export async function relayArtifacts(ctx: Context, parentId: SessionId, childId: SessionId): Promise<number> {
  const parent = ctx.agents.get(parentId)
  if (parent === undefined) throw new Error('Resume the parent conversation to present child files')
  if (!(await ctx.subagents.listChildren(parentId)).some(child => child.id === childId && child.mode !== 'external')) throw new Error('Child does not belong to this parent')
  using source = await ctx.sessionQuery.observeSession(childId)
  const cwd = source.projections?.values.workingDirectory ?? source.header.cwd ?? ctx.workingDirectory.defaultDirectory
  using parentSource = await ctx.sessionQuery.observeSession(parentId)
  let count = 0
  for (const event of source.events.slice(source.inheritedEventCount)) {
    if (event.type !== 'deliverables/presented') continue
    const key = `mydot/artifacts/${childId}/${event.seq}`
    const matches = (message: UserMessage): boolean => message.source.kind === 'mydot' && message.source.sections.some(section => section.name === key)
    if (parentSource.events.some(item => item.type === 'user/message' ? matches(item.data)
      : item.type === 'agent/inbox/spliced' && item.data.inserted.some(matches))) continue
    const files = await Promise.all(event.data.files.map(async file => ({ ...file,
      path: ctx.fs.processPath(await ctx.fs.resolve(file.path, { cwd })),
    })))
    const text = 'Child-declared current files; their contents are not verified. ' + JSON.stringify({ childSessionId: childId, files })
    parent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'mydot', form: 'snapshot', sections: [{ name: key, text }] } }))
    count += 1
  }
  return count
}
