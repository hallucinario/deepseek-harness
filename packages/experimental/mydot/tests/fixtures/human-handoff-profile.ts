/** Keyless model fixture mounted only through the shipped dsh Web profile. */
import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-mydot'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'

export const name = 'mydot-human-handoff-profile-fixture'
export const inject = ['llm']
/** Explicit public-fixture inputs; this fixture reads no private source material. */
export interface Config { workspace: string; metadataFile: string; requestId: string; sourceUrl: string; targetJson: string }
export const Config: z<Config> = z.object({ workspace: z.string().required(), metadataFile: z.string().required(),
  requestId: z.string().required(), sourceUrl: z.string().default(''), targetJson: z.string().default('null') })

function hasTool(messages: readonly RequestMessage[], name: string): boolean {
  return messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call' && block.name === name))
}

/** Register a deterministic external-model replacement, then prepare one real persisted request.
 * @param ctx - Shipped profile Context; no separate application is launched.
 * @param config - Public source, isolated workspace and output metadata path.
 */
export function apply(ctx: Context, config: Config): void {
  const target: unknown = JSON.parse(config.targetJson)
  const respond = (options: GenerateOptions): StreamChunk[] => {
    const answered = options.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.startsWith('Human response to the prepared request.')))
    if (!answered) return toolCallResponse('prepare-human-request', 'prepare_human_request', {
      request_id: config.requestId, question: 'Review the public source and save the confirmed revision',
      reason: 'A separate human observation is needed before the saved result can be used', evidence_url: config.sourceUrl,
      resume_instruction: 'Write a result artifact referencing the saved survey revision', options: [], ...target === null ? {} : { target },
    })
    if (!hasTool(options.messages, 'write')) return toolCallResponse('write-human-result', 'write', {
      file_path: 'human-handoff-result.md', content: 'Public fixture: the original Session consumed its versioned human answer and produced this result.\n',
    })
    if (!hasTool(options.messages, 'record_human_request_outcome')) return toolCallResponse('record-human-result', 'record_human_request_outcome', {
      request_id: config.requestId, outcome: 'succeeded', evidence: 'human-handoff-result.md',
    })
    return textResponse('The public fixture answer was consumed by the original Session; its result is saved in human-handoff-result.md.')
  }
  ctx.llm.registerAdapter(['human-handoff-fixture'], new MockAdapter([respond, respond, respond, respond, respond]))
  ctx.inject(['mydot', 'mydotHandoff', 'sessionController', 'sessionQuery', 'agents'], async (ready) => {
    const previous = (await ready.mydotHandoff.snapshot()).find(view => view.request.requestId === config.requestId)
    if (previous !== undefined) {
      await writeFile(config.metadataFile, JSON.stringify({ sessionId: previous.request.sessionId,
        request: previous.request }, null, 2), { mode: 0o600 })
      return
    }
    const created = await ready.sessionController.create({ cwd: config.workspace })
    await ready.sessionController.prompt({ sessionId: created.sessionId, requestId: 'public-human-handoff-bootstrap' as SessionRequestId, mode: 'queue',
      content: [{ type: 'text', text: 'Prepare the configured public-fixture human review. Do not call any external service.' }] }, new AbortController().signal)
    const agent = ready.agents.get(created.sessionId)
    if (agent === undefined) throw new Error('Fixture original Session was not activated')
    await agent.whenIdle()
    const prepared = (await ready.mydotHandoff.snapshot()).find(view => view.request.requestId === config.requestId)
    if (prepared === undefined) throw new Error('Fixture did not prepare its durable request')
    await writeFile(config.metadataFile, JSON.stringify({ sessionId: created.sessionId,
      request: prepared.request }, null, 2), { mode: 0o600 })
  })
}
