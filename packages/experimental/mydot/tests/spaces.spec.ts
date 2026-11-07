/** Space records retain original Session classification across archive and restart. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { mydotDomain, SpaceId } from '../src/storage.ts'
import { Spaces } from '../src/spaces.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
async function setup(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('memory', backend))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  const domain = await facility.open(mydotDomain)
  ctx.effect(() => async () => { await domain.close(); await backend.close() })
  return { ctx, pool, spaces: new Spaces(domain) }
}

it('archives without changing files, cwd or Session associations, and restores from durable records', async () => {
  const first = await setup()
  const space = await first.spaces.save({ name: 'Research', purpose: 'Read the reports', instructions: 'Cite sources', materials: ['/reports/a.md'], workspaceId: WorkspaceId('workspace-original') })
  await first.spaces.attach(SessionId('parent'), space.id)
  const secondSpace = await first.spaces.save({ name: 'Other', purpose: '', instructions: '', materials: [] })
  await expect(first.spaces.attach(SessionId('parent'), secondSpace.id)).rejects.toThrow('already belongs')
  await first.spaces.save({ ...space, archived: true })
  expect(first.spaces.forSession(SessionId('parent'))).toMatchObject({ id: space.id, archived: true, materials: ['/reports/a.md'], workspaceId: 'workspace-original' })
  await first.ctx.fiber.dispose()
  const restored = await setup(first.pool)
  expect(restored.spaces.list()).toHaveLength(2)
  expect(restored.spaces.forSession(SessionId('parent'))?.id).toBe(space.id)
  await expect(restored.spaces.attach(SessionId('new'), space.id)).rejects.toThrow('archived')
})

it('rejects missing Spaces and atomically retains the first competing Session association', async () => {
  const test = await setup()
  await expect(test.spaces.attach(SessionId('parent'), SpaceId('missing'))).rejects.toThrow('not found')
  const a = await test.spaces.save({ name: 'A', purpose: '', instructions: '', materials: [] })
  const b = await test.spaces.save({ name: 'B', purpose: '', instructions: '', materials: [] })
  const results = await Promise.allSettled([test.spaces.attach(SessionId('parent'), a.id), test.spaces.attach(SessionId('parent'), b.id)])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(test.spaces.forSession(SessionId('parent'))?.id).toBe(a.id)
})
