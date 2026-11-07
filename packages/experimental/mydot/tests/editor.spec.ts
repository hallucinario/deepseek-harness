/** Optimistic text editing preserves the caller's draft on stale writes. */
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { TextFiles } from '../src/files.ts'

it('saves observed versions and returns the current file alongside a retained stale draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mydot-edit-'))
  const path = join(root, 'note.md')
  await writeFile(path, 'original')
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem)
  try {
    const files = new TextFiles(ctx.fs, 65536)
    const first = await files.read(path)
    expect(first.kind).toBe('text')
    if (first.kind !== 'text') throw new Error('expected text')
    await writeFile(path, 'agent update')
    const conflict = await files.save({ path, content: 'human draft', version: first.version })
    expect(conflict).toMatchObject({ kind: 'conflict', draft: 'human draft', current: { content: 'agent update' } })
    expect(await readFile(path, 'utf8')).toBe('agent update')
    if (conflict.kind !== 'conflict' || conflict.current.kind !== 'text') throw new Error('expected current')
    const saved = await files.save({ path, content: 'merged', version: conflict.current.version })
    expect(saved.kind).toBe('saved')
    expect(await readFile(path, 'utf8')).toBe('merged')
    expect(await files.read(join(root, 'missing.md'))).toEqual({ kind: 'missing', path: join(root, 'missing.md') })
  } finally { await ctx.fiber.dispose() }
})

it('creates an absent memory file once and retains the second creator draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mydot-memory-create-'))
  const path = join(root, 'personal', 'MEMORY.md')
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem)
  try {
    const files = new TextFiles(ctx.fs, 65536)
    expect(await files.save({ path, content: 'first', version: null })).toMatchObject({ kind: 'saved' })
    expect(await files.save({ path, content: 'second', version: null })).toMatchObject({ kind: 'conflict', draft: 'second', current: { content: 'first' } })
  } finally { await ctx.fiber.dispose() }
})
