/** Generic Space input around the real MyDot service and shipped headless profile. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'mydot-material-search-fixture'
export const inject = ['storageDomain', 'sessionPersistence', 'fs', 'agents', 'credentials', 'tools']

export async function apply(ctx) {
  const entry = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
  const load = async path => {
    const plugin = await import(new URL(`../../../${path}/${entry}`, import.meta.url).href)
    return plugin.default ?? plugin
  }
  await ctx.plugin(await load('packages/client/connection'))
  await ctx.plugin(await load('packages/client/file-upload'))
  await ctx.plugin(await load('packages/workspace/workspace'))
  await ctx.plugin(await load('packages/api/session-controller'))
  const mydot = await load('packages/experimental/mydot')
  const storageEntry = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/types/storage.js' : 'src/storage.ts'
  const { mydotDomain } = await import(new URL(`../../../packages/experimental/mydot/${storageEntry}`, import.meta.url).href)
  // Seed stable fixture identifiers, then release the domain for its real owner.
  const domain = await ctx.storageDomain.open(mydotDomain)
  try {
    await domain.table('spaces').put('snapshot-materials', {
      id: 'snapshot-materials', name: 'Inspection', purpose: 'Review the supplied scaffold report',
      instructions: 'Quote the selected source and check its date before reusing a decision.',
      materials: ['report.md', 'missing.md'], archived: false, revision: 1,
    })
  } finally {
    await domain.close()
  }
  await ctx.plugin(mydot, { memoryDirectory: join(process.cwd(), '.dsh', 'mydot-memory'),
    materialSearch: { maxFiles: 2, maxContextBytes: 2048 } })

  const fs = ctx.fs
  const originalStat = fs.stat
  const stat = originalStat.bind(fs)
  // Only provider metadata varies by host; the file read and hash remain real.
  fs.stat = async (target, signal) => {
    const info = await stat(target, signal)
    if (info === undefined || fs.processPath(target) !== join(process.cwd(), 'report.md')) return info
    return { ...info, version: 'snapshot-report-v1' }
  }
  ctx.effect(() => () => { fs.stat = originalStat }, 'MyDot snapshot: metadata clock restoration')
  await ctx.plugin({
    name: 'mydot-material-search-attach',
    inject: ['mydot'],
    apply(caller) {
      caller.on('agent/created', async ({ agent }) => { await caller.mydot.attach(agent.id, 'snapshot-materials') })
    },
  })

  ctx.on('agent/pre-step', async (_payload, next) => {
    // Stabilize the recorded read time without changing Date.now or timeout clocks.
    const OriginalDate = globalThis.Date
    class PreparationDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? ['2026-11-09T00:00:00.000Z'] : args)) }
    }
    globalThis.Date = PreparationDate
    try { return await next() } finally { globalThis.Date = OriginalDate }
  }, { prepend: true })

  const reports = []
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'mydot') return
    if (event.data.source.sections?.some(section => section.name === 'mydot-material-search')) {
      reports.push(JSON.parse(event.data.content[0].text))
    }
  })
  ctx.effect(() => async () => {
    const [report] = reports
    const original = await readFile(join(process.cwd(), 'report.md'), 'utf8')
    if (reports.length !== 1 || report.status !== 'matched' || report.results.length !== 1
      || report.results[0].line !== 2 || report.results[0].version !== 'snapshot-report-v1'
      || report.results[0].contentSha256 !== createHash('sha256').update(original).digest('hex')
      || !report.results[0].text.includes('end guard') || JSON.stringify(report).includes('UNSELECTED SOURCE')
      || report.issues[0]?.code !== 'FS_NOT_FOUND' || report.incomplete !== true) {
      throw new Error('MyDot snapshot must record the selected source, its version and the missing-source diagnostic')
    }
  }, 'MyDot snapshot: durable source assertions')
  ctx.provide('mydotSnapshotReady', {})
}
