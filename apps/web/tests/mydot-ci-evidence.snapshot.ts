/** Recorded child requests acquire CI evidence through the real CLI, Remote, browser, and durable Session paths. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { parseSnapshotManifest, sessionFixtureFiles } from '@deepseek-ai/dsh-session-snapshot'
import type { MyDotSnapshot, Space, VerificationView } from '@deepseek-ai/dsh-experimental-mydot/types'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import type { TestContext } from 'vitest'
import { withDefaultWeb, webGet, webRequest } from '../../cli/tests/profiles/web/tests/default-web-process.ts'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureIdentity, parseSeedFixture, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/mydot-ci-evidence', import.meta.url))
const MODE = webSnapshotMode()
const PARENT = SessionId('mydot-evidence-recorded-parent')
const CHILD = SessionId('mydot-evidence-recorded-child')
const COMMIT = 'a'.repeat(40)
const NEXT_COMMIT = 'd'.repeat(40)
const WORKSPACE = 'mydot-evidence-workspace'
const CHECK = { id: 'repo-lint', repository: 'owner/repo', workflowPath: '.github/workflows/ci.yml',
  workflowFileSha: 'b'.repeat(40), jobName: 'Lint (Static)', description: 'The selected commit passes the configured static checks.' }

/** Materialize only the recorded fixture's typed identities and owned paths. */
function realize(source: string, workspace: string): string {
  return source.split(/\r?\n/).filter(line => line !== '').map(line => JSON.stringify(JSON.parse(line, (_key, value: unknown) => {
    if (typeof value !== 'string') return value
    return value.replaceAll('{{session:1}}', PARENT).replaceAll('{{session:2}}', CHILD).replaceAll('{{cwd}}', workspace)
      .replace(/\{\{(message|approval|workflow|command|rpc|retry|id):([1-9]\d*)\}\}/g,
        (_token, kind: Parameters<typeof fixtureIdentity>[0], ordinal: string) => fixtureIdentity(kind, Number(ordinal)))
  }))).join('\n') + '\n'
}

/** Restore the referenced parent and child recordings through the real storage contract before Web starts. */
async function seed(world: string): Promise<Map<SessionId, readonly SessionEvent[]>> {
  const manifestPath = join(DIR, 'snapshot.yml')
  const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
  if (manifest.session === undefined) throw new Error('Evidence scenario must reference its recorded Session owner')
  const owner = dirname(resolve(DIR, manifest.session.source))
  const roles = sessionFixtureFiles(await readdir(owner))
  expect(roles.map(role => role.index)).toEqual([0, 1])
  const ctx = new Context()
  const originals = new Map<SessionId, readonly SessionEvent[]>()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: join(world, 'sessions'), compression: 'none' })
    for (const role of roles) {
      const decoded = parseSeedFixture(realize(await readFile(join(owner, role.name), 'utf8'), join(world, WORKSPACE)))
      const { type: _type, ...header } = decoded.header
      const meta = header as unknown as SessionHeader
      expect(decoded.events.at(-1)?.type).toBe('turn/end')
      const handle = await ctx.sessionPersistence.create(meta)
      try {
        await handle.append(decoded.events)
        await handle.flush()
      } finally { await handle.close() }
      originals.set(meta.id, decoded.events)
    }
  } finally { await ctx.fiber.dispose() }
  return originals
}

/** Read independently persisted events, without a live Agent or Session projection. */
async function stored(world: string, id: SessionId): Promise<readonly SessionEvent[]> {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: join(world, 'sessions'), compression: 'none' })
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try { return (await handle.read()).events }
    finally { await handle.close() }
  } finally { await ctx.fiber.dispose() }
}

/** Authenticate exactly as a browser and use only published Remote endpoints. */
async function connect(url: string, signal: AbortSignal) {
  const auth = await webGet(url, signal)
  const cookie = auth.headers['set-cookie']?.[0]?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('Web did not establish its browser session')
  return async <T>(method: string, args: Record<string, unknown>): Promise<T> => {
    const rpcId = randomUUID()
    const response = await webRequest(new URL(`/api/${method}`, url), signal, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    expect(response.status, response.text).toBe(200)
    const envelope = JSON.parse(response.text) as { type: string; rpcId: string; result: { ok: boolean; value: T } }
    expect(envelope, response.text).toMatchObject({ type: 'server-response', rpcId, result: { ok: true } })
    return envelope.result.value
  }
}

function evidence(snapshot: MyDotSnapshot): VerificationView {
  const job = snapshot.jobs.find(item => item.childSessionId === CHILD)
  expect(job).toMatchObject({ parentSessionId: PARENT, status: 'inactive' })
  if (job?.verification === undefined) throw new Error(`Recorded child has no evidence projection: ${JSON.stringify(snapshot)}`)
  return job.verification
}

async function openMyDot(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.getByRole('dialog', { name: 'Preview Notice', exact: true }).getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByLabel('MyDot', { exact: true }).click()
}

async function openEvidence(page: Page, url: string): Promise<void> {
  await openMyDot(page, url)
  await page.getByRole('region', { name: 'CI evidence' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Show CI details', exact: true }).click()
}

async function status(page: Page, expected: string): Promise<void> {
  await expect.poll(() => page.getByRole('region', { name: 'CI evidence' }).getByRole('status').textContent(),
    { timeout: 15_000 }).toBe(expected)
}

async function capture(page: Page, world: string, view: VerificationView): Promise<string> {
  return captureStableAria(page, '[aria-label="CI evidence"]', join(world, WORKSPACE), {
    replacements: view.history.map((entry, index) =>
      [new Date(entry.observation.observedAt).toISOString(), `{{observedAt:${index + 1}}}`] as const),
  })
}

async function prepare(test: TestContext, verificationEnabled = true) {
  const world = await mkdtemp(join(tmpdir(), 'dsh-mydot-evidence-snapshot-'))
  test.onTestFinished(async () => { await rm(world, { recursive: true, force: true }) })
  await mkdir(join(world, WORKSPACE))
  const originals = await seed(world)
  const patch = join(world, 'cordis.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'session-persistence-jsonl', config: { root: join(world, 'sessions'), compression: 'none' } },
    { id: 'storage-json', config: { root: join(world, 'storages') } },
    { id: 'session-title-llm', disabled: true },
    { insert: [
      { id: 'mydot-github-fixture', name: pathToFileURL(join(DIR, 'github-fixture.mjs')).href,
        config: { directory: join(world, 'github') } },
      { id: 'mydot-evidence', name: pathToFileURL(join(REPO_ROOT, 'packages/experimental/mydot/lib/index.js')).href,
        config: { memoryDirectory: join(world, 'memory'), verificationChecks: verificationEnabled ? [CHECK] : [] } },
    ] },
  ]))
  return { world, originals, patch }
}

function persistedEvidence(events: readonly SessionEvent[], baseline: number): string {
  return JSON.stringify(events.slice(baseline), (key, value: unknown) =>
    key === 'time' || key === 'observedAt' ? '{{timestamp}}' : value, 2)
}

it.skipIf(process.platform === 'win32' || MODE === 'record')(
  'keeps ordinary MyDot mounted without the opt-in Host evidence service or evidence calls', async (test) => {
    const { world, originals, patch } = await prepare(test, false)
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    const browser = await chromium.launch({ timeout: test.task.timeout,
      ...(executablePath === undefined ? {} : { executablePath }) })
    test.onTestFinished(async () => { await browser.close() })
    await withDefaultWeb(test, async ({ url }) => {
      const rpc = await connect(url, test.signal)
      const space = await rpc<Space>('mydot/saveSpace', {
        input: { name: 'Evidence disabled', purpose: '', instructions: '', materials: [] },
      })
      await rpc('mydot/attach', { sessionId: PARENT, spaceId: space.id })
      const snapshot = await rpc<MyDotSnapshot>('mydot/snapshot', {})
      expect(snapshot.verificationChecks).toBeUndefined()
      expect(snapshot.jobs).toMatchObject([{ parentSessionId: PARENT, childSessionId: CHILD, status: 'inactive' }])
      expect(snapshot.jobs[0]!.verification).toBeUndefined()
      const page = await newEnglishPage(browser)
      const evidenceRequests: string[] = []
      const errors: string[] = []
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/mydotEvidence/')) evidenceRequests.push(request.url())
      })
      page.on('pageerror', error => errors.push(error.message))
      try {
        await openMyDot(page, url)
        await page.getByRole('heading', { name: 'MyDot', exact: true }).waitFor({ state: 'visible' })
        await page.getByText('echo probe', { exact: true }).waitFor({ state: 'visible' })
        expect(await page.getByRole('button', { name: 'Open original conversation', exact: true }).count()).toBe(1)
        expect(await page.getByRole('region', { name: 'CI evidence', exact: true }).count()).toBe(0)
        expect(evidenceRequests).toEqual([])
        expect(errors).toEqual([])
        expect(await readdir(join(world, 'github'))).toEqual(['gh'])
        expect(await stored(world, CHILD)).toEqual(originals.get(CHILD))
        expect(await stored(world, PARENT)).toEqual(originals.get(PARENT))
      } finally { await page.close() }
    }, { patches: [patch] })
  },
)

it.skipIf(process.platform === 'win32' || MODE === 'record')(
  'persists MyDot evidence through the public Web protocol for a recorded child without a model turn', async (test) => {
    const { world, originals, patch } = await prepare(test)
    let confirmed: VerificationView | undefined
    let persisted: readonly SessionEvent[] = []
    await withDefaultWeb(test, async ({ url }) => {
      const rpc = await connect(url, test.signal)
      const space = await rpc<Space>('mydot/saveSpace', {
        input: { name: 'Recorded evidence', purpose: '', instructions: '', materials: [] },
      })
      await rpc('mydot/attach', { sessionId: PARENT, spaceId: space.id })
      const initial = evidence(await rpc<MyDotSnapshot>('mydot/snapshot', {}))
      expect(initial).toMatchObject({ target: null, status: 'unobserved', history: [] })
      const request = initial.requests[0]
      if (request === undefined) throw new Error('Recorded child has no local request')
      const target = await rpc<{ seq: number }>('mydotEvidence/setTarget', {
        sessionId: CHILD, input: { requestSeq: request.seq, checkId: CHECK.id, commit: COMMIT },
      })
      for (const [runId, outcome] of [[101, 'passed'], [102, 'failed'], [103, 'unavailable']] as const) {
        await rpc('mydotEvidence/refresh', { sessionId: CHILD, targetSeq: target.seq, runId })
        expect(evidence(await rpc<MyDotSnapshot>('mydot/snapshot', {})).status).toBe(outcome)
      }
      await rpc('mydotEvidence/setTarget', {
        sessionId: CHILD, input: { requestSeq: request.seq, checkId: CHECK.id, commit: NEXT_COMMIT },
      })
      confirmed = evidence(await rpc<MyDotSnapshot>('mydot/snapshot', {}))
      expect(confirmed.status).toBe('unobserved')
      expect(confirmed.history.map(entry => entry.current)).toEqual([false, false, false])
      persisted = await stored(world, CHILD)
      const baseline = originals.get(CHILD)
      if (baseline === undefined) throw new Error('Missing recorded child baseline')
      expect(persisted.slice(0, baseline.length)).toEqual(baseline)
      expect(persisted.slice(baseline.length).map(event => pluginRecordOf(event)?.type)).toEqual([
        'plugin:mydot/verification-target', 'plugin:mydot/verification-observation',
        'plugin:mydot/verification-observation', 'plugin:mydot/verification-observation', 'plugin:mydot/verification-target',
      ])
      await compareOrRefreshGolden(join(DIR, 'persisted.expected.json'), persistedEvidence(persisted, baseline.length), MODE)
      expect(await stored(world, PARENT)).toEqual(originals.get(PARENT))
    }, { patches: [patch] })
    await withDefaultWeb(test, async ({ url }) => {
      const rpc = await connect(url, test.signal)
      expect(evidence(await rpc<MyDotSnapshot>('mydot/snapshot', {}))).toEqual(confirmed)
      expect(await stored(world, CHILD)).toEqual(persisted)
    }, { patches: [patch] })
  },
)

it.skipIf(process.platform === 'win32' || MODE === 'record')(
  'records MyDot CI evidence for a cold recorded child, retains scoped history, and restores it in the browser', async (test) => {
    const { world, originals, patch } = await prepare(test)
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    const browser = await chromium.launch({ timeout: test.task.timeout,
      ...(executablePath === undefined ? {} : { executablePath }) })
    test.onTestFinished(async () => { await browser.close() })
    const errors: string[] = []
    let beforeRestart: VerificationView | undefined
    let beforeEvents: readonly SessionEvent[] = []
    await withDefaultWeb(test, async ({ url }) => {
      const rpc = await connect(url, test.signal)
      const space = await rpc<Space>('mydot/saveSpace', { input: { name: 'Recorded evidence', purpose: '', instructions: '', materials: [] } })
      await rpc('mydot/attach', { sessionId: PARENT, spaceId: space.id })
      const initial = evidence(await rpc<MyDotSnapshot>('mydot/snapshot', {}))
      expect(initial).toMatchObject({ target: null, status: 'unobserved', history: [] })
      const request = initial.requests[0]
      if (request === undefined) throw new Error('Recorded child has no local request')
      expect(request.text).toContain('Reply with exactly: child answer 42.')
      const page = await newEnglishPage(browser)
      page.on('pageerror', error => errors.push(error.message))
      try {
        await openEvidence(page, url)
        await status(page, 'No observation for this target')
        await page.getByLabel('Full commit SHA', { exact: true }).fill(COMMIT)
        await page.getByRole('button', { name: 'Save target', exact: true }).click()
        await page.getByLabel('Existing GitHub Actions run ID', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
        await page.getByLabel('Existing GitHub Actions run ID', { exact: true }).fill('101')
        await page.getByRole('button', { name: 'Read existing CI result', exact: true }).click()
        await status(page, 'Specified condition confirmed for this commit')
        const confirmed = evidence(await rpc<MyDotSnapshot>('mydot/snapshot', {}))
        expect(confirmed.target?.request).toEqual(request)
        expect(confirmed.history).toMatchObject([{ current: true, observation: { outcome: 'passed', run: { id: 101, commit: COMMIT } } }])
        await page.getByText('Observation history', { exact: true }).click()
        await page.getByRole('link', { name: 'Workflow run 101, attempt 2', exact: true }).waitFor({ state: 'visible' })
        await compareOrRefreshGolden(join(DIR, 'confirmed.expected.md'), await capture(page, world, confirmed), MODE)

        await page.getByLabel('Existing GitHub Actions run ID', { exact: true }).fill('102')
        await page.getByRole('button', { name: 'Read existing CI result', exact: true }).click()
        await status(page, 'Specified condition failed')
        await page.getByLabel('Existing GitHub Actions run ID', { exact: true }).fill('103')
        await page.getByRole('button', { name: 'Read existing CI result', exact: true }).click()
        await status(page, 'Could not confirm the condition')
        await page.getByLabel('Full commit SHA', { exact: true }).fill(NEXT_COMMIT)
        await page.getByRole('button', { name: 'Save target', exact: true }).click()
        await status(page, 'No observation for this target')
        beforeRestart = evidence(await rpc<MyDotSnapshot>('mydot/snapshot', {}))
        expect(beforeRestart.target).toMatchObject({ commit: NEXT_COMMIT, request })
        expect(beforeRestart.history.map(entry => ({ current: entry.current, outcome: entry.observation.outcome })))
          .toEqual([{ current: false, outcome: 'passed' }, { current: false, outcome: 'failed' }, { current: false, outcome: 'unavailable' }])
        await page.getByLabel('Existing GitHub Actions run ID', { exact: true }).fill('')
        await compareOrRefreshGolden(join(DIR, 'historical.expected.md'), await capture(page, world, beforeRestart), MODE)
        beforeEvents = await stored(world, CHILD)
        const original = originals.get(CHILD)
        if (original === undefined) throw new Error('Missing recorded child baseline')
        expect(beforeEvents.slice(0, original.length)).toEqual(original)
        const appended = beforeEvents.slice(original.length)
        expect(appended.map(event => pluginRecordOf(event)?.type)).toEqual([
          'plugin:mydot/verification-target', 'plugin:mydot/verification-observation',
          'plugin:mydot/verification-observation', 'plugin:mydot/verification-observation', 'plugin:mydot/verification-target',
        ])
        const persisted = persistedEvidence(beforeEvents, original.length)
        await compareOrRefreshGolden(join(DIR, 'persisted.expected.json'), persisted, MODE)
        expect(await stored(world, PARENT)).toEqual(originals.get(PARENT))
      } finally { await page.close() }
    }, { patches: [patch] })

    await withDefaultWeb(test, async ({ url }) => {
      const rpc = await connect(url, test.signal)
      const restored = evidence(await rpc<MyDotSnapshot>('mydot/snapshot', {}))
      expect(restored).toEqual(beforeRestart)
      const page = await newEnglishPage(browser)
      page.on('pageerror', error => errors.push(error.message))
      try {
        await openEvidence(page, url)
        await status(page, 'No observation for this target')
        await page.getByText('Observation history', { exact: true }).click()
        await compareOrRefreshGolden(join(DIR, 'historical.expected.md'), await capture(page, world, restored), MODE)
        expect(await stored(world, CHILD)).toEqual(beforeEvents)
        expect(await stored(world, PARENT)).toEqual(originals.get(PARENT))
      } finally { await page.close() }
    }, { patches: [patch] })
    const requests = (await readFile(join(world, 'github', 'requests.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as string[])
    expect(requests).toHaveLength(9)
    expect(requests.every(args => args.slice(0, 5).join(' ') === 'api --hostname github.com --method GET')).toBe(true)
    expect(errors).toEqual([])
    await assertFixtureInventory(DIR, [
      'confirmed.expected.md', 'historical.expected.md', 'persisted.expected.json', 'gh.mjs', 'github-fixture.mjs',
    ])
  },
)
