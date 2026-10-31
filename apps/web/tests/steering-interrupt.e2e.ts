/** Browser steering interrupts an unfinished reasoning request and continues the same turn. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, type MockInstance } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, pinBrowserClock, pinHostClock, saveFailureShot } from './support.ts'

const EXPECTED_DIR = fileURLToPath(new URL('./expected/steering-interrupt', import.meta.url))
const MODE = webSnapshotMode()
const PROMPT = 'Consider the implementation before answering.'
const THINKING = 'I am considering the original implementation.'
const STEER = 'Use the revised requirements and answer with REVISION_ACCEPTED.'

describe.skipIf(MODE === 'record')('web e2e: steering interrupts model reasoning', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let hostClock: MockInstance<typeof Date.now> | undefined
  let disposeStream: (() => void) | undefined
  const sessionEvents: SessionEvent[] = []
  const requests: GenerateOptions[] = []

  beforeAll(async () => {
    hostClock = pinHostClock()
    scaffold = await launchWebScaffold({
      replayFixture: join(EXPECTED_DIR, 'session.jsonl'),
      replayOverride: join(EXPECTED_DIR, 'replay.override.json'),
      paceMs: 20,
    })
    scaffold.ctx.on('session/event', (_session, event) => { sessionEvents.push(event) })
    disposeStream = scaffold.ctx.on('llm/stream', async function* (options, next) {
      requests.push(options)
      const firstRequest = requests.length === 1
      // The hanging replay's visible prefix is reasoning in this scenario.
      // It only ends when its request signal is aborted.
      for await (const chunk of next()) {
        if (firstRequest && chunk.type === 'block-start') {
          yield { ...chunk, blockType: 'reasoning' }
        } else if (firstRequest && chunk.type === 'text-delta') {
          yield { ...chunk, type: 'reasoning-delta', text: THINKING }
        } else {
          yield chunk
        }
      }
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await pinBrowserClock(page)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    disposeStream?.()
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        hostClock?.mockRestore()
      }
    }
  })

  it('aborts thinking on Cmd+Enter and admits the new instruction once without ending the turn', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-steering-interrupt'))
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const settled = scaffold.whenTurnSettled(30_000)
    await input.fill(PROMPT)
    await input.press('Enter')
    await page.locator('[data-variant="think"][data-state="running"]').first()
      .waitFor({ state: 'attached', timeout: 10_000 })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.signal?.aborted).toBe(false)

    await input.fill(STEER)
    await input.press('Meta+Enter')
    await expect.poll(() => requests.length, { timeout: 10_000 }).toBe(2)
    expect(requests[0]?.signal?.aborted).toBe(true)
    expect(JSON.stringify(requests[1]?.messages)).toContain(PROMPT)
    expect(JSON.stringify(requests[1]?.messages)).toContain(STEER)
    await settled

    expect(sessionEvents.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(sessionEvents.filter(event => event.type === 'turn/end').map(event => event.data.reason))
      .toEqual([{ kind: 'completed' }])
    expect(sessionEvents.filter(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === STEER))).toHaveLength(1)
    const interrupted = sessionEvents.filter((event): event is SessionEvent<'assistant/message'> =>
      event.type === 'assistant/message' && event.data.interrupted === true)
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]?.data.message.content).toEqual([{ type: 'reasoning', text: THINKING }])
    expect(sessionEvents.filter(event => event.type === 'tool/call')).toHaveLength(0)
    await expect.poll(() => page.getByText(STEER, { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await page.getByText('REVISION_ACCEPTED', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.locator('[data-pending-steering]').count()).toBe(0)
    expect(await page.locator('[data-queue-dock]').count()).toBe(0)
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(EXPECTED_DIR, 'settled.expected.md'), snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(EXPECTED_DIR, ['replay.override.json', 'settled.expected.md'])
  })
})
