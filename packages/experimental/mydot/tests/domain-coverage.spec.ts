/** Domain regressions for cancellation, durable identities and failed operations. */
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { relayArtifacts } from '../src/artifacts.ts'
import { JobControls } from '../src/control.ts'
import { DesktopOwnership } from '../src/desktop.ts'
import { TextFiles } from '../src/files.ts'
import { readJobRequest } from '../src/job-request.ts'
import { Spaces } from '../src/spaces.ts'
import { mydotDomain, SpaceId } from '../src/storage.ts'
import type { JobInput } from '../src/types.ts'
import type {} from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function storage() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('memory', backend))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  const domain = await facility.open(mydotDomain)
  ctx.effect(() => async () => { await domain.close(); await backend.close() })
  return { domain, pool, spaces: new Spaces(domain) }
}

const metadata = { name: 'Research', purpose: '', instructions: '', materials: [] }

describe('Space associations and failed writes', () => {
  it('rejects stale and absent replacements and continues after a failed write', async () => {
    const { spaces, pool } = await storage()
    await expect(spaces.save({ ...metadata, id: SpaceId('absent'), revision: 1 })).rejects.toThrow('not found')
    const first = await spaces.save(metadata)
    const updated = await spaces.save({ ...first, name: 'Renamed' })
    await expect(spaces.save(first)).rejects.toThrow('changed')
    pool.failNextWrites = 1
    await expect(spaces.save({ ...updated, name: 'Uncommitted' })).rejects.toThrow('injected write failure')
    await spaces.drain()
    expect(spaces.list()).toEqual([updated])
    expect(await spaces.save({ ...updated, archived: true })).toMatchObject({ archived: true, revision: 3 })
  })

  it('inherits archived classification idempotently, rejects conflicting children and tolerates orphan links', async () => {
    const { spaces, domain } = await storage()
    const parent = SessionId('parent')
    const child = SessionId('child')
    expect(spaces.forSession(child)).toBeUndefined()
    await spaces.inherit(parent, child)
    expect(spaces.forSession(child)).toBeUndefined()
    const first = await spaces.save(metadata)
    const other = await spaces.save({ ...metadata, name: 'Other' })
    await spaces.attach(parent, first.id)
    await spaces.attach(parent, first.id)
    await spaces.save({ ...first, archived: true })
    await spaces.inherit(parent, child)
    await spaces.inherit(parent, child)
    expect(spaces.forSession(child)).toMatchObject({ id: first.id, archived: true })
    await spaces.attach(SessionId('other-child'), other.id)
    await expect(spaces.inherit(parent, SessionId('other-child'))).rejects.toThrow('another Space')
    await domain.table('sessions').put(SessionId('orphan'), { spaceId: SpaceId('missing') })
    expect(spaces.forSession(SessionId('orphan'))).toBeUndefined()
  })
})

describe('desktop cancellation and ownership', () => {
  it('keeps completion idempotent and rejects release during an operation or human handoff', () => {
    const desktop = new DesktopOwnership()
    const owner = SessionId('owner')
    const finish = desktop.begin(owner)
    expect(() => desktop.begin(owner)).toThrow('still active')
    expect(() =>{  desktop.release(owner) }).toThrow('Finish')
    finish()
    finish()
    expect(desktop.snapshot().inFlight).toBe(0)
    desktop.requestHandoff()
    expect(() =>{  desktop.release(owner) }).toThrow('Finish')
    expect(() =>{  desktop.claim(owner) }).toThrow('held by a person')
    desktop.observed(12)
    expect(() => desktop.resume(SessionId('other'), 12)).toThrow('another job')
    expect(() => desktop.resume(owner, 11)).toThrow('fresh')
    desktop.resume(owner, 12)
    expect(() =>{  desktop.release(SessionId('other')) }).toThrow('Finish')
    desktop.release(owner)
    expect(desktop.snapshot()).toEqual({ phase: 'free', inFlight: 0 })
  })

  it('rejects pre-aborted and non-Error cancellation reasons and removes cancelled waiters', async () => {
    const desktop = new DesktopOwnership()
    const owner = SessionId('owner')
    const aborted = new AbortController()
    aborted.abort(new Error('already cancelled'))
    await expect(desktop.acquire(owner, aborted.signal)).rejects.toThrow('already cancelled')
    const finish = desktop.begin(owner)
    const cancel = new AbortController()
    const waiting = desktop.acquire(SessionId('waiting'), cancel.signal)
    cancel.abort('caller gone')
    await expect(waiting).rejects.toMatchObject({ message: 'Desktop admission cancelled', cause: 'caller gone' })
    finish()
    desktop.release(owner)
    expect(desktop.snapshot()).toEqual({ phase: 'free', inFlight: 0 })
  })

  it('accepts a fresh capture before an unclaimed desktop receives its first owner', () => {
    const desktop = new DesktopOwnership()
    expect(desktop.requestHandoff().phase).toBe('human')
    desktop.observed(50)
    expect(desktop.resume(SessionId('first'), 50)).toMatchObject({ phase: 'agent', owner: 'first' })
  })
})

describe('text file errors', () => {
  async function files(maxBytes = 8) {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalFileSystem)
    const root = await mkdtemp(join(tmpdir(), 'mydot-domain-'))
    const path = join(root, 'note.txt')
    await writeFile(path, 'hello')
    return { ctx, root, path, files: new TextFiles(ctx.fs, maxBytes) }
  }

  it('rejects directories, oversized files, binary files and oversized multibyte drafts', async () => {
    const test = await files()
    await expect(test.files.read(test.root)).rejects.toThrow('regular text file')
    await writeFile(test.path, '123456789')
    await expect(test.files.read(test.path)).rejects.toThrow('editor limit')
    await writeFile(test.path, Buffer.from([0, 1, 2]))
    await expect(test.files.read(test.path)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await expect(test.files.save({ path: test.path, content: '界界界', version: null })).rejects.toThrow('Draft exceeds')
  })

  it('checks actual bytes when a provider omits size and propagates unreadability', async () => {
    const test = await files()
    vi.spyOn(test.ctx.fs, 'stat').mockResolvedValue({ type: 'file', version: FsVersion('one') })
    const readText = vi.spyOn(test.ctx.fs, 'readText').mockResolvedValueOnce('界界界')
    await expect(test.files.read(test.path)).rejects.toThrow('editor limit')
    const error = new FsError('Permission denied', 'FS_PERMISSION_DENIED')
    readText.mockRejectedValueOnce(error)
    await expect(test.files.read(test.path)).rejects.toBe(error)
  })

  it.each(['changed', 'disappeared'] as const)('rejects a file that %s during a read', async (change) => {
    const test = await files()
    vi.spyOn(test.ctx.fs, 'stat')
      .mockResolvedValueOnce({ type: 'file', size: 5, version: FsVersion('before') })
      .mockResolvedValueOnce(change === 'changed' ? { type: 'file', size: 5, version: FsVersion('after') } : undefined)
    await expect(test.files.read(test.path)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it.each([new Error('transport failed'), new FsError('disk unavailable', 'FS_IO_ERROR')])('propagates write failures: %s', async (error) => {
    const test = await files()
    vi.spyOn(test.ctx.fs, 'writeText').mockRejectedValue(error)
    await expect(test.files.save({ path: test.path, content: 'draft', version: null })).rejects.toBe(error)
  })
})

it.each([
  ['ordinary prose', undefined], ['MyDot job request: {', undefined],
  ['MyDot job request: null', undefined], ['MyDot job request: {"prompt":42}', undefined],
  ['MyDot job request: {}', undefined], ['MyDot job request: {"prompt":"original"}', 'original'],
] as const)('reads only recognized durable job metadata: %s', (text, expected) => {
  expect(readJobRequest(text)).toBe(expected)
})

const parentId = SessionId('parent')
const childId = SessionId('child')
const request: JobInput = { parentSessionId: parentId, childSessionId: childId, requestId: 'request' as JobInput['requestId'], text: 'do the work', delivery: 'queue' }

function message(text = request.text, rpcId = request.requestId): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId } })
}

describe('job inbox identities', () => {
  it('rejects cancellation and unauthorized children before prompting', async () => {
    const listChildren = vi.fn(async () => [{ id: childId, mode: 'external' }])
    const prompt = vi.fn()
    const ctx = { subagents: { listChildren, prompt } } as never as Context
    const controls = new JobControls(ctx)
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled before admission'))
    await expect(controls.send(request, cancelled.signal)).rejects.toThrow('cancelled before admission')
    expect(listChildren).not.toHaveBeenCalled()
    await expect(controls.send(request, new AbortController().signal)).rejects.toThrow('direct continuable child')
    expect(prompt).not.toHaveBeenCalled()
  })

  it.each(['user/message', 'agent/inbox/spliced'] as const)('deduplicates %s and disposes observations', async (type) => {
    const accepted = message()
    const dispose = vi.fn()
    const prompt = vi.fn()
    const events = [{ type: 'unrelated', data: {} }, { type, data: type === 'user/message' ? accepted : { inserted: [accepted] } }]
    const ctx = { subagents: { listChildren: async () => [{ id: childId, mode: 'continuable' }], prompt },
      sessionQuery: { observeSession: async () => ({ events, inheritedEventCount: 0, [Symbol.dispose]: dispose }) } } as never as Context
    const controls = new JobControls(ctx)
    expect(await controls.send(request, new AbortController().signal)).toEqual({ messageId: accepted.id })
    await expect(controls.send({ ...request, text: 'different' }, new AbortController().signal)).rejects.toThrow('different input')
    expect(prompt).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('serializes duplicates until the first admission appears in the pending durable inbox', async () => {
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const events: object[] = [{ type: 'user/message', data: message('inherited') }]
    const accepted = message()
    const prompt = vi.fn(async () => {
      entered.resolve(undefined)
      await finish.promise
      events.push({ type: 'agent/inbox/spliced', data: { inserted: [accepted] } })
      return { messageId: accepted.id }
    })
    const ctx = { subagents: { listChildren: async () => [{ id: childId, mode: 'continuable' }], prompt },
      sessionQuery: { observeSession: async () => ({ events, inheritedEventCount: 1, [Symbol.dispose]() {} }) } } as never as Context
    const controls = new JobControls(ctx)
    const first = controls.send(request, new AbortController().signal)
    await entered.promise
    const second = controls.send(request, new AbortController().signal)
    finish.resolve(undefined)
    expect(await first).toEqual(await second)
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})

function artifactFixture() {
  const childDispose = vi.fn()
  const parentDispose = vi.fn()
  const followup = vi.fn()
  const child = { events: [
    { type: 'deliverables/presented', seq: 0, data: { files: [{ path: 'inherited.md' }] } },
    { type: 'user/message', seq: 1, data: message('child input') },
    { type: 'deliverables/presented', seq: 2, data: { files: [{ path: 'report.md', description: 'Report' }] } },
  ], inheritedEventCount: 1, projections: { values: { workingDirectory: '/project' } }, header: { cwd: '/header' }, [Symbol.dispose]: childDispose }
  const parent = { events: [] as object[], [Symbol.dispose]: parentDispose }
  const resolve = vi.fn(async (path: string, options: { cwd: string }) => ({ displayPath: `${options.cwd}/${path}` }))
  const observeSession = vi.fn(async (id: SessionId) => id === childId ? child : parent)
  const get = vi.fn((): { followup: typeof followup } | undefined => ({ followup }))
  const children = [{ id: childId, mode: 'continuable' }]
  const ctx = { agents: { get }, subagents: { listChildren: async () => children }, sessionQuery: { observeSession },
    fs: { resolve, processPath: (target: { displayPath: string }) => target.displayPath }, workingDirectory: { defaultDirectory: '/default' } } as never as Context
  return { ctx, child, parent, children, get, resolve, observeSession, followup, childDispose, parentDispose }
}

describe('child artifact presentation', () => {
  it('rejects a missing live parent or a foreign/external child before observing files', async () => {
    const test = artifactFixture()
    test.get.mockReturnValueOnce(undefined)
    await expect(relayArtifacts(test.ctx, parentId, childId)).rejects.toThrow('Resume the parent')
    test.children[0]!.id = SessionId('foreign')
    await expect(relayArtifacts(test.ctx, parentId, childId)).rejects.toThrow('does not belong')
    test.children[0] = { id: childId, mode: 'external' }
    await expect(relayArtifacts(test.ctx, parentId, childId)).rejects.toThrow('does not belong')
    expect(test.observeSession).not.toHaveBeenCalled()
  })

  it('excludes inherited declarations, resolves current paths and disposes both observations', async () => {
    const test = artifactFixture()
    expect(await relayArtifacts(test.ctx, parentId, childId)).toBe(1)
    expect(test.resolve).toHaveBeenCalledExactlyOnceWith('report.md', { cwd: '/project' })
    expect(test.followup).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(test.followup.mock.calls)).toContain('/project/report.md')
    expect(JSON.stringify(test.followup.mock.calls)).not.toContain('inherited.md')
    expect(test.childDispose).toHaveBeenCalledOnce()
    expect(test.parentDispose).toHaveBeenCalledOnce()
  })

  it.each(['user/message', 'agent/inbox/spliced'] as const)('deduplicates a declaration already in %s', async (type) => {
    const test = artifactFixture()
    const presented = createUserMessage({ content: [{ type: 'text', text: 'already queued' }],
      source: { kind: 'mydot', form: 'snapshot', sections: [{ name: `mydot/artifacts/${childId}/2`, text: 'already queued' }] } })
    test.parent.events.push({ type: 'turn/start' }, { type: 'user/message', data: message('ordinary') },
      { type, data: type === 'user/message' ? presented : { inserted: [presented] } })
    expect(await relayArtifacts(test.ctx, parentId, childId)).toBe(0)
    expect(test.followup).not.toHaveBeenCalled()
    expect(test.resolve).not.toHaveBeenCalled()
  })

  it('does not confuse an unrelated MyDot section with this declaration', async () => {
    const test = artifactFixture()
    const unrelated = createUserMessage({ content: [{ type: 'text', text: 'memory' }],
      source: { kind: 'mydot', form: 'snapshot', sections: [{ name: 'memory', text: 'memory' }] } })
    test.parent.events.push({ type: 'agent/inbox/spliced', data: { inserted: [unrelated] } })
    expect(await relayArtifacts(test.ctx, parentId, childId)).toBe(1)
  })

  it.each(['header', 'default'] as const)('resolves relative paths from %s when projected cwd is absent', async (fallback) => {
    const test = artifactFixture()
    Reflect.deleteProperty(test.child.projections.values, 'workingDirectory')
    if (fallback === 'default') Reflect.deleteProperty(test.child.header, 'cwd')
    expect(await relayArtifacts(test.ctx, parentId, childId)).toBe(1)
    expect(test.resolve).toHaveBeenCalledWith('report.md', { cwd: `/${fallback}` })
  })

  it('disposes both observations on resolution failure without announcing files', async () => {
    const test = artifactFixture()
    const error = new Error('filesystem unavailable')
    test.resolve.mockRejectedValueOnce(error)
    await expect(relayArtifacts(test.ctx, parentId, childId)).rejects.toBe(error)
    expect(test.followup).not.toHaveBeenCalled()
    expect(test.childDispose).toHaveBeenCalledOnce()
    expect(test.parentDispose).toHaveBeenCalledOnce()
  })

  it('disposes the child observation when the parent cannot be observed', async () => {
    const test = artifactFixture()
    test.observeSession.mockResolvedValueOnce(test.child).mockRejectedValueOnce(new Error('parent unavailable'))
    await expect(relayArtifacts(test.ctx, parentId, childId)).rejects.toThrow('parent unavailable')
    expect(test.childDispose).toHaveBeenCalledOnce()
    expect(test.followup).not.toHaveBeenCalled()
  })

  it('propagates inbox rejection and releases both observations', async () => {
    const test = artifactFixture()
    test.followup.mockImplementationOnce(() => { throw new Error('inbox closed') })
    await expect(relayArtifacts(test.ctx, parentId, childId)).rejects.toThrow('inbox closed')
    expect(test.childDispose).toHaveBeenCalledOnce()
    expect(test.parentDispose).toHaveBeenCalledOnce()
  })
})

it('readmits a quiescent owner while keeping another owner and human-held desktop waiting', async () => {
  const desktop = new DesktopOwnership()
  const owner = SessionId('owner')
  desktop.claim(owner)
  const done = await desktop.acquire(owner, new AbortController().signal)
  done()
  const other = new AbortController()
  const waiting = desktop.acquire(SessionId('other'), other.signal)
  other.abort(new Error('other cancelled'))
  await expect(waiting).rejects.toThrow('other cancelled')
  desktop.requestHandoff()
  const human = new AbortController()
  const action = desktop.acquire(owner, human.signal)
  human.abort(new Error('human retains desktop'))
  await expect(action).rejects.toThrow('human retains desktop')
  expect(desktop.snapshot()).toMatchObject({ phase: 'human', inFlight: 0, owner })
})

it('settles cancellation that races with abort-listener subscription', async () => {
  const desktop = new DesktopOwnership()
  const owner = SessionId('owner')
  const finish = desktop.begin(owner)
  const cancellation = new AbortController()
  const subscribe = cancellation.signal.addEventListener.bind(cancellation.signal)
  vi.spyOn(cancellation.signal, 'addEventListener').mockImplementationOnce((type, listener, options) => {
    cancellation.abort(new Error('cancelled during subscription'))
    subscribe(type, listener, options)
  })
  await expect(desktop.acquire(SessionId('other'), cancellation.signal)).rejects.toThrow('cancelled during subscription')
  finish()
  desktop.release(owner)
  expect(desktop.snapshot()).toEqual({ phase: 'free', inFlight: 0 })
})
