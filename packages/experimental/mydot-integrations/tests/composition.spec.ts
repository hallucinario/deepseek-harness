import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as MyDot from '../src/index.ts'
import { failure } from '../src/transport.ts'
import { fixture, json, success, TOKEN } from './harness.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('MyDot real Loader composition', () => {
  it('runs tools with the executing Agent Session, respects denial and unregisters on unload', async () => {
    const f = await fixture(cleanups, (seen, res) => {
      if (seen.request.sessionId === 'child-session') {  json(res, failure('session_grant_required', 'This exact Session needs its own grant.'), 403); return }
      json(res, success(seen.request, { connections: [{ connectionId: 'account-a', label: 'Work', provider: 'microsoft', resources: [] }] }))
    })
    const source = await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8')
    const path = join(f.root, 'cordis.yml')
    await writeFile(path, source.replace('BROKER_ORIGIN', JSON.stringify(f.config.brokerUrl)).replace('EXECUTOR_TOKEN_FILE', JSON.stringify(f.config.executorTokenFile)))
    const ctx = await boot('mydot-test-composition', path, [], (host) => {
      Object.assign(host.loader.builtins, { llm: LlmRuntime, sessions: SessionStore, projections: SessionProjectionRegistry,
        prompt: SystemPrompt, tools: ToolRuntime, agents: AgentRegistry, loop: AgentLoop, mydot: MyDot })
    })
    cleanups.push(() => ctx.fiber.dispose())
    const agent = await ctx.agentLoop.create(SessionId('parent-session'))
    const child = await ctx.agentLoop.create(SessionId('child-session'))
    const call = { name: 'mydot_connections_list', arguments: { arguments: {} }, signal: new AbortController().signal }
    const result = await ctx.tools.execute({ ...call, callId: ToolCallId('account-list'), agent })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Work')
    expect(JSON.stringify(result.content)).toContain('external_untrusted_data')
    expect(JSON.stringify(result.content)).not.toContain(TOKEN)
    const denied = await ctx.tools.execute({ ...call, callId: ToolCallId('child-list'), agent: child })
    expect(JSON.stringify(denied.content)).toContain('session_grant_required')
    expect(f.requests.map(item => item.request.sessionId)).toEqual(['parent-session', 'child-session'])
    const missing = await ctx.tools.execute({ ...call, callId: ToolCallId('missing-agent') })
    expect(JSON.stringify(missing.content)).toContain('agent_required')
    const spoofed = await ctx.tools.execute({ ...call, callId: ToolCallId('spoof'), agent, arguments: { arguments: {}, sessionId: 'parent-session' } })
    expect(JSON.stringify(spoofed.content)).toContain('invalid_arguments')
    expect(f.requests).toHaveLength(2)
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('mydot_'))).toHaveLength(14)
    expect(ctx.tools.schemas().some(tool => /mydot.*(?:send|markRead|deleteMail)/u.test(tool.name))).toBe(false)
    await ctx.fiber.dispose()
  })

  it('removes all tools on plugin unload and restores one set after reload', async () => {
    const f = await fixture(cleanups, (seen, res) =>{  json(res, success(seen.request)) })
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const first = ctx.plugin(MyDot, f.config)
    await first
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('mydot_'))).toHaveLength(14)
    await first.dispose()
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('mydot_'))).toHaveLength(0)
    await ctx.plugin(MyDot, f.config)
    expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('mydot_'))).toHaveLength(14)
  })
})
