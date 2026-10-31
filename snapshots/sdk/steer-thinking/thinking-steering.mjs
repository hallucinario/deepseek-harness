/** Deterministic model stream shared by the TypeScript and Python SDK projections. */
import { randomUUID } from 'node:crypto'

export const name = 'thinking-steering-fixture'
export const inject = ['llm', 'agents']

/** Submit steering after a delivered reasoning chunk, before that response can finish. */
export function apply(ctx) {
  ctx.on('llm/stream', async function* (request, next) {
    if (request.provider !== 'deepseek-official') { yield* next(); return }
    const agent = ctx.agents.requireInitiator()
    const steering = request.messages.filter(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === 'Reply with exactly: STEERING_OK'))
    if (steering.length === 0) {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'Thinking before the correction.' }
      agent.steer({
        id: randomUUID(), role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'Reply with exactly: STEERING_OK' }],
      })
      if (!request.signal.aborted) throw new Error('Steering did not interrupt the active model request')
      request.signal.throwIfAborted()
      return
    }
    if (steering.length !== 1) throw new Error('Steering was delivered more than once')
    const partial = request.messages.find(message => message.role === 'assistant'
      && message.content.some(block => block.type === 'reasoning' && block.text === 'Thinking before the correction.'))
    if (partial === undefined) throw new Error('The interrupted reasoning prefix was not retained')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'STEERING_OK' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'STEERING_OK' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
}
