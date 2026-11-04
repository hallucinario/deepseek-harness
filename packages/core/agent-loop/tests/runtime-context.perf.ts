/** Fixed-input admission diagnostic: run with --expose-gc, a module path and before|current. */
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, renderRuntimeContextSnapshot } from '@deepseek-ai/dsh-llm'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RuntimeContextProjection } from '../src/runtime-context.ts'

const [file, variant] = process.argv.slice(2)
if (file === undefined || (variant !== 'before' && variant !== 'current') || global.gc === undefined) {
  throw new Error('Run node --expose-gc --import tsx/esm runtime-context.perf.ts <module-path> before|current')
}
const module: unknown = await import(pathToFileURL(resolve(file)).href)
if (typeof module !== 'object' || module === null
  || !('RuntimeContextProjection' in module) || typeof module.RuntimeContextProjection !== 'function') {
  throw new TypeError('The supplied module must export RuntimeContextProjection')
}
const Projection = module.RuntimeContextProjection as typeof RuntimeContextProjection
const ctx = new Context()
await ctx.plugin(Sessions)
const session = ctx.sessions.create(SessionId('runtime-context-performance'))
const projection = new Projection(ctx, session)
try {
  global.gc()
  const before = process.memoryUsage()
  const began = performance.now()
  for (let index = 0; index < 1000; index += 1) {
    session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: `Work ${index}` }],
    }), { surfaceOp: 'append' })
    const sections = [
      { name: 'working-directory:current', text: 'Current working directory: /diagnostic/workspace.' },
      { name: 'memory-experience', text: `${index}: ${'concrete tool evidence '.repeat(40)}`, retention: 'current' as const },
    ]
    const text = renderRuntimeContextSnapshot(sections)
    const decision = variant === 'current' ? projection.reconcile(text, sections)
      : { enableCurrent: false, message: projection.project(text, sections), replacements: [] }
    if (decision.enableCurrent) session.append('runtime-context/current-enabled', { retention: 'current' })
    for (const { message, intent } of decision.replacements) session.append('user/message', message, intent)
    if (decision.message !== undefined) session.append('user/message', decision.message, { surfaceOp: 'append' })
  }
  const elapsedMs = performance.now() - began
  global.gc()
  const after = process.memoryUsage()
  console.log(JSON.stringify({
    variant, updates: 1000, elapsedMs, peakRssKiB: process.resourceUsage().maxRSS, steadyHeapBytes: after.heapUsed,
    retainedHeapDeltaBytes: after.heapUsed - before.heapUsed, rawEvents: session.seq, surfaceNodes: session.surface.nodes.length,
    node: process.version, platform: process.platform, arch: process.arch,
  }))
} finally {
  await ctx.fiber.dispose()
}
