import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as BrokerPlugin from '../src/index.ts'
import { BrokerServer } from '../src/server.ts'
import { BrokerStore } from '../src/store.ts'
import { key } from './support.ts'

let context: Context | undefined
let root: string | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.restoreAllMocks()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe.skipIf(process.platform === 'win32')('broker through real Loader composition with POSIX permissions', () => {
  it('serves its fixed policy, denies unauthorized operations and releases ingress and the database on disposal', async () => {
    root = await mkdtemp(join(tmpdir(), 'mydot-broker-loader-'))
    const files = { encryptionKeyFile: join(root, 'key'), executorTokenFile: join(root, 'executor'), adminTokenFile: join(root, 'admin'), oauthConfigFile: join(root, 'oauth.json') }
    await Promise.all([
      writeFile(files.encryptionKeyFile, key.toString('hex'), { mode: 0o600 }),
      writeFile(files.executorTokenFile, 'fixture-executor-'.repeat(3), { mode: 0o600 }),
      writeFile(files.adminTokenFile, 'fixture-administrator-'.repeat(3), { mode: 0o600 }),
      writeFile(files.oauthConfigFile, JSON.stringify({ google: { clientId: 'fixture-client', clientSecret: 'fixture-secret' } }), { mode: 0o600 }),
    ])
    const config: BrokerPlugin.Config = { ...files, stateDirectory: join(root, 'state'), host: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1:0', requestTimeoutMs: 10_000, maxBodyBytes: 8192, maxResponseBytes: 16384, maxQueuedRequests: 4, maxGrantLifetimeMs: 3600_000, microsoftConditionalWritesVerified: false }
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, `- name: 'cordis:mydot-broker-fixture'\n  config: ${JSON.stringify(config)}\n`)
    const listen = vi.spyOn(BrokerServer.prototype, 'listen')
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.builtins['mydot-broker-fixture'] = BrokerPlugin
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    expect(listen).toHaveBeenCalledTimes(1)
    const instance = listen.mock.contexts[0]
    if (!(instance instanceof BrokerServer)) throw new Error('Expected a real effect-owned broker server')
    const base = `http://127.0.0.1:${instance.port()}`
    expect(await (await fetch(base + '/health')).json()).toMatchInlineSnapshot(`
      {
        "policy": "no-send",
        "status": "ok",
        "version": 1,
      }
    `)
    expect((await fetch(base + '/v1/execute', { method: 'POST' })).status).toBe(404)
    await context.fiber.dispose()
    context = undefined
    await expect(fetch(base + '/health')).rejects.toThrow()
    const reopened = new BrokerStore(config.stateDirectory, key)
    expect(reopened.state.connections).toEqual([])
    reopened.close()
  })
})
