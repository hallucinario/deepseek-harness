/** Real custom-profile boot and resume; only the LLM and broker HTTP peers are fixtures. */

import { createServer } from 'node:http'
import { once } from 'node:events'
import { globSync } from 'node:fs'
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { fixture, json, success } from './harness.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const example = fileURLToPath(new URL('../examples/mydot-integrations-safe/', import.meta.url))

describe('MyDot restricted custom profile', () => {
  it('requires its socket, exposes exactly 14 tools and resumes the same persisted grant identity', async () => {
    const broker = await fixture(cleanups, (seen, res) => { json(res, success(seen.request, { connections: [] })) })
    const modelRequests: Array<{ tools: Array<{ function: { name: string } }> }> = []
    const llm = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        modelRequests.push(JSON.parse(body) as { tools: Array<{ function: { name: string } }> })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const call = modelRequests.length === 1 || modelRequests.length === 3
        const delta = call
          ? { role: 'assistant', tool_calls: [{ index: 0, id: `accounts-${modelRequests.length}`, type: 'function', function: { name: 'mydot_connections_list', arguments: '{"arguments":{}}' } }] }
          : { role: 'assistant', content: 'DONE' }
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      })
    })
    cleanups.push(() => new Promise<void>((resolve, reject) => {
      llm.close((error) => { if (error === undefined) resolve(); else reject(error) })
      llm.closeAllConnections()
    }))
    llm.listen(0, '127.0.0.1')
    await once(llm, 'listening')
    const address = llm.address()
    if (address === null || typeof address === 'string') throw new Error('LLM fixture has no TCP address')
    const profile = join(broker.root, '.dsh', 'profiles', 'mydot-integrations-safe')
    await mkdir(join(profile, 'node_modules', '@deepseek-ai'), { recursive: true })
    await copyFile(join(example, 'package.json'), join(profile, 'package.json'))
    await copyFile(join(example, 'cordis.patch.yml'), join(profile, 'cordis.patch.yml'))
    // This environment cannot bind Unix sockets; only the external broker transport is replaced for this smoke.
    const fixturePatch = join(broker.root, 'http-fixture.patch.yml')
    await writeFile(fixturePatch, `- id: mydot-integrations\n  config:\n    brokerUrl: ${JSON.stringify(broker.config.brokerUrl)}\n    executorTokenFile: ${JSON.stringify(broker.config.executorTokenFile)}\n    requestTimeoutMs: 30000\n    maxResultBytes: 65536\n`)
    const declared = JSON.parse(await readFile(join(example, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const locations = new Map<string, string>()
    for (const path of globSync(['packages/*/*/package.json'], { cwd: repo })) {
      const manifest = JSON.parse(await readFile(join(repo, path), 'utf8')) as { name: string }
      locations.set(manifest.name, dirname(join(repo, path)))
    }
    for (const name of Object.keys(declared.dependencies)) {
      const location = locations.get(name)
      if (location === undefined) throw new Error(`Missing test workspace package ${name}`)
      await symlink(location, join(profile, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
    }
    const env = {
      MYDOT_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, MYDOT_LLM_MODEL: 'fixture-model', LITELLM_MASTER_KEY: 'fixture-model-key',
      MYDOT_BROKER_URL: broker.config.brokerUrl, MYDOT_EXECUTOR_TOKEN_FILE: broker.config.executorTokenFile,
      MYDOT_SESSION_DIRECTORY: join(broker.root, 'sessions'), DSH_TELEMETRY_DISABLED: '1',
    }
    const options = {
      label: 'MyDot restricted profile', cwd: broker.root,
      binScript: join(repo, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm' as const,
      configPath: join(profile, 'cordis.patch.yml'), tsconfigPath: join(repo, 'tsconfig.json'), env,
    }
    const missingSocket = await runLoaderSmoke({ ...options,
      binArgs: ['--profile', 'mydot-integrations-safe', '--json', 'List MyDot accounts.'], expectedExitCode: 1,
    })
    expect(`${missingSocket.stdout}${missingSocket.stderr}`).toContain('executorSocketPath')
    expect(broker.requests).toHaveLength(0)
    expect(modelRequests).toHaveLength(0)
    const first = await runLoaderSmoke({ ...options, binArgs: ['--profile', 'mydot-integrations-safe', '--patch', fixturePatch, '--json', 'List MyDot accounts.'] })
    expect(first.stdout).toContain('DONE')
    expect(broker.requests).toHaveLength(1)
    const sessionId = broker.requests[0]!.request.sessionId
    const expected = [
      'mydot_connections_list', 'mydot_resources_list', 'mydot_calendar_list', 'mydot_calendar_get',
      'mydot_calendar_create', 'mydot_calendar_update', 'mydot_calendar_delete', 'mydot_mail_list', 'mydot_mail_get',
      'mydot_mail_createDraft', 'mydot_mail_updateDraft', 'mydot_mail_replyDraft', 'mydot_mail_forwardDraft', 'mydot_mail_organize',
    ].sort()
    for (const request of modelRequests) expect(request.tools.map(tool => tool.function.name).sort()).toEqual(expected)
    const resumed = await runLoaderSmoke({ ...options, binArgs: ['--profile', 'mydot-integrations-safe', '--patch', fixturePatch, '--session-id', sessionId, '--json', 'List MyDot accounts again.'] })
    expect(resumed.stdout).toContain('DONE')
    expect(broker.requests).toHaveLength(2)
    expect(broker.requests[1]!.request.sessionId).toBe(sessionId)
    for (const request of modelRequests) expect(request.tools.map(tool => tool.function.name).sort()).toEqual(expected)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS * 3)
})
