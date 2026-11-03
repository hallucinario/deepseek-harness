import { afterEach, expect, it, vi } from 'vitest'
import type { CordisInspectQueryRequest, CordisInspectRequestId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import {
  ClientCordisInspectRegistry, type ClientCordisInspectHost, type ClientCordisInspectProviderRegistration,
} from '../src/client/inspect-registry.ts'

afterEach(() => { vi.restoreAllMocks() })

const provider: ClientCordisInspectProviderRegistration = {
  manifest: {
    id: 'Service', description: 'Read a service.',
    methods: [{ name: 'read', description: 'Read.', inputSchema: {}, outputSchema: {} }],
  },
  query: () => Promise.resolve({ name: 'test' }),
}
const request: CordisInspectQueryRequest = {
  requestId: 'request' as CordisInspectRequestId, agentId: 'session' as SessionId,
  provider: 'Service', method: 'read',
}

function host() {
  return {
    sync: vi.fn<ClientCordisInspectHost['sync']>(() => Promise.resolve()),
    resolve: vi.fn<ClientCordisInspectHost['resolve']>(() => Promise.resolve()),
  }
}

it('stops queued publication and refuses new registrations after disposal', async () => {
  const transport = host()
  const registry = new ClientCordisInspectRegistry(transport)
  const remove = registry.register(provider)
  await registry.dispose()
  remove()
  registry.publish()
  await registry.query(request)
  await registry.dispose()
  expect(transport.sync).not.toHaveBeenCalled()
  expect(transport.resolve).not.toHaveBeenCalled()
  expect(() => registry.register(provider)).toThrow('is disposed')
})

it('waits for a started publication and cancels the publication queued behind it', async () => {
  const transport = host()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  transport.sync.mockImplementation(async () => { entered.resolve(undefined); await release.promise })
  const registry = new ClientCordisInspectRegistry(transport)
  registry.register(provider)
  await entered.promise
  registry.publish()
  await Promise.resolve()
  let stopped = false
  const closing = registry.dispose().then(() => { stopped = true })
  try {
    await Promise.resolve()
    expect(stopped).toBe(false)
  } finally {
    release.resolve(undefined)
    await closing
  }
  expect(transport.sync).toHaveBeenCalledExactlyOnceWith([provider.manifest])
})

it('cancels active provider work and waits without submitting a stale query result', async () => {
  const transport = host()
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<undefined>()
  const registry = new ClientCordisInspectRegistry(transport)
  registry.register({
    ...provider,
    query: async (_method, _input, context) => {
      entered.resolve(context.signal)
      await release.promise
      return { name: 'late' }
    },
  })
  const querying = registry.query(request)
  const signal = await entered.promise
  const closing = registry.dispose()
  try {
    expect(signal.aborted).toBe(true)
    expect(transport.resolve).not.toHaveBeenCalled()
  } finally {
    release.resolve(undefined)
    await Promise.all([querying, closing])
  }
  expect(transport.resolve).not.toHaveBeenCalled()
})

it('reports a live publication failure and publishes again after reconnect', async () => {
  const transport = host()
  const failed = Promise.withResolvers<undefined>()
  const restored = Promise.withResolvers<undefined>()
  const failure = new Error('live transport failure')
  transport.sync.mockRejectedValueOnce(failure).mockImplementation(async () => { restored.resolve(undefined) })
  const error = vi.spyOn(console, 'error').mockImplementation(() => { failed.resolve(undefined) })
  const registry = new ClientCordisInspectRegistry(transport)
  registry.register(provider)
  await failed.promise
  expect(error).toHaveBeenCalledExactlyOnceWith('[cordis-client-runner] syncing inspect providers failed:', failure)
  registry.publish()
  await restored.promise
  await registry.dispose()
  expect(transport.sync).toHaveBeenCalledTimes(2)
})

it('preserves genuine query-result transport failures', async () => {
  const transport = host()
  const failure = new Error('live result failure')
  transport.resolve.mockRejectedValue(failure)
  const registry = new ClientCordisInspectRegistry(transport)
  registry.register(provider)
  await expect(registry.query(request)).rejects.toBe(failure)
  await registry.dispose()
})
