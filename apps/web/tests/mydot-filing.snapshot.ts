/** Keyless owner-review preparation through the shipped Web profile and durable Session. */
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-experimental-mydot'
import { assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const directory = fileURLToPath(new URL('../../../snapshots/web/mydot-filing', import.meta.url))
const fixture = join(directory, 'session.v4.jsonl')

it.skipIf(webSnapshotMode() === 'record')('prepares an exact mock filing without granting model confirmation authority', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: fixture, compareReplaySession: true,
    extraOverlayPath: join(directory, 'cordis.patch.yml'), replayOverride: join(directory, 'replay.override.json'), toolsMode: 'native',
    extraInstallAnchors: [fileURLToPath(new URL('../../../packages/experimental/mydot/package.json', import.meta.url))],
    replayProviders: [{ id: 'filing-fixture', name: 'Public filing fixture', models: [{ id: 'fixture' }] }] })
  let browser: Browser | undefined
  try {
    for (const file of ['source.txt', 'preview.txt']) await copyFile(join(directory, 'workspace', file), join(scaffold.workspaceCwd, file))
    const prompts = fixtureUserPrompts(await readFile(fixture, 'utf8'))
    expect(prompts).toHaveLength(1)
    const created = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    await scaffold.ctx.sessionController.prompt({ sessionId: created.sessionId, requestId: 'public-filing-bootstrap' as SessionRequestId,
      mode: 'queue', content: [{ type: 'text', text: prompts[0]! }] }, new AbortController().signal)
    const agent = scaffold.ctx.agents.get(created.sessionId)!
    await agent.whenIdle()
    const cards = await scaffold.ctx.mydotFiling.snapshot()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ confirmationReady: false, filing: { sessionId: created.sessionId,
      revision: 1, phase: 'prepared', actor: 'model-preparer', control: 'agent', plan: { amount: '1000', forms: ['public-return'] } } })
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'mydot/filing-case')).toHaveLength(1)
    expect(events.filter(event => event.type === 'mydot/filing')).toHaveLength(1)
    expect(events.filter(event => event.type === 'mydot/mock-receipt')).toHaveLength(0)
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
    expect(cards[0]?.filing.receipt).toBeUndefined()
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const console = watchConsole(page)
    const consoleErrors: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'MyDot', exact: true }).click()
    const card = page.locator('[data-filing-case]')
    await card.waitFor()
    expect(await card.getByRole('status').innerText()).toBe('Owner review required')
    expect(await card.getByRole('button', { name: 'Approve this exact plan', exact: true }).isEnabled()).toBe(true)
    expect(await card.getByRole('button', { name: 'Confirm mock submission', exact: true }).count()).toBe(0)
    const output = process.env.DSH_MYDOT_QA_DIR
    if (output !== undefined) await mkdir(output, { recursive: true })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      if (output !== undefined) await page.screenshot({ path: join(output, `mydot-filing-${width}.png`), fullPage: true })
    }
    await card.getByRole('button', { name: 'Open reviewed document source.txt', exact: true }).click()
    await page.getByRole('textbox', { name: 'Edit text', exact: true }).waitFor()
    expect(await page.getByRole('textbox', { name: 'Edit text', exact: true }).inputValue()).toBe('Public synthetic filing source.\n')
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
    expect(consoleErrors).toEqual([])
  } finally {
    try { await browser?.close() }
    finally { await scaffold.close() }
  }
  await assertFixtureInventory(directory, ['cordis.patch.yml', 'replay.override.json', 'session.v4.jsonl',
    'system-prompt.expected.md', 'tool-schemas.expected.json', 'workspace'])
})
