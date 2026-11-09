/** Explicit material selection, source identity and complete UTF-8 context bounds. */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { expect, it, vi } from 'vitest'
import { searchMaterials, minimumMaterialContextBytes } from '../src/material-search.ts'

async function setup(onTestFinished: (fn: () => Promise<void>) => void) {
  const root = await mkdtemp(join(tmpdir(), 'mydot-materials-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  return { ctx, root }
}

const limits = { maxFiles: 4, maxContextBytes: 4096, maxFileBytes: 262144 }

it('selects matching lines from only the explicit files with content identity and source coordinates', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  const content = '# Received report\nScaffold inspection uses photographs.\nThe scaffold draft needs an end guard.\n'
  await writeFile(join(root, 'report.md'), content)
  await writeFile(join(root, 'unselected.md'), 'Scaffold draft SECRET from another Space')
  await writeFile(join(root, 'unrelated.md'), 'Lunch is ready.')
  const text = await searchMaterials(ctx.fs, ['unrelated.md', 'report.md'], root, 'scaffold draft', limits, new AbortController().signal)
  const result = JSON.parse(text)
  expect(result.status).toBe('matched')
  expect(result.results).toHaveLength(1)
  expect(result.results[0]).toMatchObject({ path: join(root, 'report.md'), line: 3, text: 'The scaffold draft needs an end guard.',
    contentSha256: createHash('sha256').update(content).digest('hex'), column: 1, truncated: false })
  expect(result.results[0].version).toBeTypeOf('string')
  expect(Number.isNaN(Date.parse(result.retrievedAt))).toBe(false)
  expect(result.guidance).toContain('not instructions')
  expect(text).not.toContain('SECRET')
  expect(text).not.toContain('Lunch')
})

it('matches Japanese words without treating the complete sentence as one keyword', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await writeFile(join(root, 'notes.md'), '足場の端部には防護が必要。\n資料の返信案を確認する。')
  const text = await searchMaterials(ctx.fs, ['notes.md'], root, '足場の端部を確認してください', limits, new AbortController().signal)
  expect(JSON.parse(text).results[0]).toMatchObject({ line: 1, text: '足場の端部には防護が必要。' })
})

it('does not match unrelated Japanese sources solely on shared particles or polite request words', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await writeFile(join(root, 'notes.md'), '足場の端部には防護が必要。')
  const text = await searchMaterials(ctx.fs, ['notes.md'], root, '宇宙飛行の方針', limits, new AbortController().signal)
  expect(JSON.parse(text)).toMatchObject({ status: 'no-match', results: [] })
  const polite = await searchMaterials(ctx.fs, ['notes.md'], root, 'の を してください', limits, new AbortController().signal)
  expect(JSON.parse(polite)).toMatchObject({ status: 'no-query', results: [] })
})

it('retains meaningful single-character Japanese queries and exact columns after expanding lowercase', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await writeFile(join(root, 'width.md'), '幅は400mm。')
  const width = await searchMaterials(ctx.fs, ['width.md'], root, '幅', limits, new AbortController().signal)
  expect(JSON.parse(width).results[0].text).toBe('幅は400mm。')
  const content = 'İ'.repeat(1500) + ' TARGET ' + '終'.repeat(1500)
  await writeFile(join(root, 'case.md'), content)
  const text = await searchMaterials(ctx.fs, ['case.md'], root, 'target', { ...limits, maxContextBytes: 900 }, new AbortController().signal)
  const excerpt = JSON.parse(text).results[0]
  expect(excerpt.text).toContain('TARGET')
  expect([...content].slice(excerpt.column - 1, excerpt.column - 1 + [...excerpt.text].length).join('')).toBe(excerpt.text)
})

it('bounds the serialized result including metadata, escaping and multibyte excerpts', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await writeFile(join(root, 'large.md'), '前'.repeat(1500) + ' scaffold ' + '後"\\'.repeat(1500))
  const text = await searchMaterials(ctx.fs, ['large.md'], root, 'scaffold', { ...limits, maxContextBytes: 900 }, new AbortController().signal)
  const result = JSON.parse(text)
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(900)
  expect(result.results[0].text).toContain('scaffold')
  expect(result.results[0].truncated).toBe(true)
  expect(result.results[0].column).toBeGreaterThan(1)
  expect(result.results[0].text).not.toContain('\uFFFD')
})

it('reports an exact minimal budget without emitting source fragments that cannot fit', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await writeFile(join(root, 'note.md'), 'scaffold')
  const text = await searchMaterials(ctx.fs, ['note.md'], root, 'scaffold', { ...limits, maxContextBytes: minimumMaterialContextBytes }, new AbortController().signal)
  expect(text).toBe('{"status":"budget-exhausted"}')
  expect(Buffer.byteLength(text)).toBe(minimumMaterialContextBytes)
})

it('distinguishes no query and no matches and never recursively scans a selected directory', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await mkdir(join(root, 'directory'))
  await writeFile(join(root, 'directory', 'secret.md'), 'scaffold SECRET')
  await writeFile(join(root, 'note.md'), 'Lunch')
  const empty = await searchMaterials(ctx.fs, ['note.md'], root, ' ! ', limits, new AbortController().signal)
  expect(JSON.parse(empty).status).toBe('no-query')
  const text = await searchMaterials(ctx.fs, ['note.md', 'directory', 'missing.md'], root, 'scaffold', limits, new AbortController().signal)
  expect(JSON.parse(text)).toMatchObject({ status: 'no-match', incomplete: true, results: [], issues: [
    { reference: 'directory', code: 'FS_NOT_REGULAR_FILE' }, { reference: 'missing.md', code: 'FS_NOT_FOUND' },
  ] })
  expect(text).not.toContain('SECRET')
})

it('limits file attempts and retains useful excerpts alongside an unreadable source', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await writeFile(join(root, 'good.md'), 'scaffold accepted')
  await writeFile(join(root, 'omitted.md'), 'scaffold OMITTED')
  const original = ctx.fs.streamText.bind(ctx.fs)
  vi.spyOn(ctx.fs, 'streamText').mockImplementation((target, signal) => target.displayPath.endsWith('blocked.md')
    ? Promise.reject(new FsError('Permission denied', 'FS_PERMISSION_DENIED')) : original(target, signal))
  await writeFile(join(root, 'blocked.md'), 'scaffold unreadable')
  const text = await searchMaterials(ctx.fs, ['blocked.md', 'good.md', 'omitted.md'], root, 'scaffold', { ...limits, maxFiles: 2 }, new AbortController().signal)
  expect(JSON.parse(text)).toMatchObject({ status: 'matched', incomplete: true, omittedFiles: 1, issues: [{ reference: 'blocked.md', code: 'FS_PERMISSION_DENIED' }] })
  expect(text).toContain('scaffold accepted')
  expect(text).not.toContain('OMITTED')
})

it('rejects stale and oversized sources and identifies unexpected provider failures', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await writeFile(join(root, 'note.md'), 'scaffold')
  vi.spyOn(ctx.fs, 'stat')
    .mockResolvedValueOnce({ type: 'file', size: 8, version: FsVersion('before') })
    .mockResolvedValueOnce({ type: 'file', size: 8, version: FsVersion('after') })
  const stale = await searchMaterials(ctx.fs, ['note.md'], root, 'scaffold', limits, new AbortController().signal)
  expect(JSON.parse(stale).issues).toEqual([{ reference: 'note.md', code: 'FS_STALE_VERSION' }])
  const large = await searchMaterials(ctx.fs, ['note.md'], root, 'scaffold', { ...limits, maxFileBytes: 3 }, new AbortController().signal)
  expect(JSON.parse(large).issues).toEqual([{ reference: 'note.md', code: 'FS_TOO_LARGE' }])
  vi.spyOn(ctx.fs, 'resolve').mockRejectedValueOnce(new Error('private transport diagnostic'))
  const failed = await searchMaterials(ctx.fs, ['note.md'], root, 'scaffold', limits, new AbortController().signal)
  expect(JSON.parse(failed).issues).toEqual([{ reference: 'note.md', code: 'SEARCH_FAILED' }])
  expect(failed).not.toContain('private transport diagnostic')
})

it('enforces the byte cap even when source size is absent or grows during streaming', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await writeFile(join(root, 'note.md'), 'scaffold')
  vi.spyOn(ctx.fs, 'stat').mockResolvedValue({ type: 'file', version: FsVersion('unknown-size') })
  const text = await searchMaterials(ctx.fs, ['note.md'], root, 'scaffold', { ...limits, maxFileBytes: 3 }, new AbortController().signal)
  expect(JSON.parse(text)).toMatchObject({ results: [], issues: [{ reference: 'note.md', code: 'FS_TOO_LARGE' }] })
})

it('ranks multiple sources by matched words and locates a later query word occurring first in the source', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await writeFile(join(root, 'partial.md'), 'scaffold only')
  await writeFile(join(root, 'complete.md'), 'guard before scaffold')
  const text = await searchMaterials(ctx.fs, ['partial.md', 'complete.md'], root, 'scaffold guard', limits, new AbortController().signal)
  expect(JSON.parse(text).results.map((item: { text: string }) => item.text)).toEqual(['guard before scaffold', 'scaffold only'])
})

it.for([315, 340])('reports budget exhaustion when %i bytes cannot carry source identity', async (maxContextBytes, { onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  await writeFile(join(root, 'note.md'), 'scaffold')
  const text = await searchMaterials(ctx.fs, ['note.md'], root, 'scaffold', { ...limits, maxContextBytes }, new AbortController().signal)
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxContextBytes)
  expect(JSON.parse(text).status).toBe('budget-exhausted')
  expect(text).not.toContain('scaffold')
})

it('counts an omitted diagnostic instead of overflowing the complete context budget', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  vi.spyOn(ctx.fs, 'resolve').mockRejectedValueOnce(new FsError('Permission denied', 'FS_PERMISSION_DENIED'))
  const text = await searchMaterials(ctx.fs, ['long-reference-'.repeat(80)], root, 'scaffold', { ...limits, maxContextBytes: 400 }, new AbortController().signal)
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(400)
  expect(JSON.parse(text)).toMatchObject({ status: 'no-match', incomplete: true, omittedIssues: 1, issues: [] })
})

it('honors cancellation instead of returning success for canceled preparation', async ({ onTestFinished }) => {
  const { ctx, root } = await setup(onTestFinished)
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await expect(searchMaterials(ctx.fs, [], root, 'scaffold', limits, controller.signal)).rejects.toThrow('cancelled')
})
